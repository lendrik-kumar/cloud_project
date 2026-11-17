import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as rekognition from 'aws-cdk-lib/aws-rekognition';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const LAMBDA_DIR = path.join(__dirname, '../lambda');
const WEB_DIST = path.join(__dirname, '../../web/dist');
const VENV_PYTHON = path.join(__dirname, '../../local/.venv/bin/python');
const COLLECTION_ID = 'cloudattend-students';
const PY_EXCLUDE = ['__pycache__', '*.pyc', '.pytest_cache'];

/** Provisioned capacity per table/index. Sum must stay <= 25 RCU and <= 25 WCU (always free). */
export const TABLE_CAPACITY: Record<string, { read: number; write: number }> = {
  StudentsTable: { read: 2, write: 2 },
  ClassesTable: { read: 2, write: 1 },
  SessionsTable: { read: 3, write: 3 },
  AttendanceTable: { read: 5, write: 5 },
  byStudentIndex: { read: 3, write: 3 },
  UsageTable: { read: 1, write: 1 },
};

/** Every REST route served by the single API Lambda (see docs/api.md). */
export const API_ROUTES: ReadonlyArray<[method: string, path: string]> = [
  ['GET', 'me'],
  ['GET', 'classes'],
  ['POST', 'classes'],
  ['PUT', 'classes/{classId}/students'],
  ['GET', 'classes/{classId}/sessions'],
  ['GET', 'classes/{classId}/sessions/{date}'],
  ['POST', 'classes/{classId}/sessions/{date}/upload-url'],
  ['PUT', 'classes/{classId}/sessions/{date}/attendance/{studentId}'],
  ['GET', 'students'],
  ['POST', 'students'],
  ['GET', 'students/{studentId}'],
  ['POST', 'students/{studentId}/photo-url'],
  ['GET', 'reports/class/{classId}'],
  ['GET', 'reports/student/{studentId}'],
];

/**
 * CloudAttend: serverless face-recognition attendance.
 *
 * Context parameters (pass with `-c key=value` or set in cdk.json):
 *   alertEmail           e-mail for ops alarms + monthly budget alerts (optional)
 *   attendanceThreshold  % below which students get an SNS e-mail (default 75)
 *   minSessionsForAlert  don't alert until a class has this many sessions (default 3)
 *   monthlyBudgetUsd     zero-spend budget limit when alertEmail is set (default 1); any actual
 *                        charge >= $0.01 e-mails alertEmail
 *   rekognitionMonthlyCap max Rekognition calls per month per API group (default 900, under the
 *                        free tier); beyond it photos are stored but not analysed
 *   maxFacesPerPhoto     only the N largest faces in a class photo are searched (default 50)
 *
 * Cost: everything is sized for the AWS free tier. DynamoDB uses fixed provisioned capacity
 * inside the always-free 25 RCU / 25 WCU, API Gateway has no detailed (paid) metrics, alarms /
 * dashboard / custom metrics stay inside CloudWatch's free allowances.
 */
export class CloudAttendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ctx = (key: string, fallback?: string): string | undefined => {
      const v = this.node.tryGetContext(key);
      return v === undefined || v === null || v === '' ? fallback : String(v);
    };
    const alertEmail = ctx('alertEmail');
    const threshold = ctx('attendanceThreshold', '75')!;
    const minSessions = ctx('minSessionsForAlert', '3')!;
    const budgetUsd = Number(ctx('monthlyBudgetUsd', '1'));
    const rekognitionCap = ctx('rekognitionMonthlyCap', '900')!;
    const maxFacesPerPhoto = ctx('maxFacesPerPhoto', '50')!;
    const removalPolicy = cdk.RemovalPolicy.DESTROY; // class project: `cdk destroy` removes everything

    // ---------------------------------------------------------------- Web hosting
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: true,
    });
    const spaFallback = (httpStatus: number): cloudfront.ErrorResponse => ({
      httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0),
    });
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: 'CloudAttend dashboard',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [spaFallback(403), spaFallback(404)],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // includes India edge locations
    });
    const webUrl = `https://${distribution.distributionDomainName}`;

    // ---------------------------------------------------------------- Photo storage
    const photos = new s3.Bucket(this, 'PhotosBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT],
        allowedOrigins: [webUrl, 'http://localhost:5173', 'http://localhost:4173'],
        allowedHeaders: ['*'],
        maxAge: 3000,
      }],
    });

    // ---------------------------------------------------------------- DynamoDB
    // Fixed provisioned capacity (no auto scaling: its alarms aren't free). Totals must stay within
    // the always-free 25 RCU / 25 WCU per region; see TABLE_CAPACITY. Burst capacity absorbs spikes.
    const table = (id: string, pk: string, sk?: string) => new ddb.Table(this, id, {
      partitionKey: { name: pk, type: ddb.AttributeType.STRING },
      sortKey: sk ? { name: sk, type: ddb.AttributeType.STRING } : undefined,
      billingMode: ddb.BillingMode.PROVISIONED,
      readCapacity: TABLE_CAPACITY[id].read,
      writeCapacity: TABLE_CAPACITY[id].write,
      removalPolicy,
    });
    const studentsTable = table('StudentsTable', 'studentId');
    const classesTable = table('ClassesTable', 'classId');
    const sessionsTable = table('SessionsTable', 'classId', 'date');
    const attendanceTable = table('AttendanceTable', 'classId', 'sk'); // sk = "<date>#<studentId>"
    attendanceTable.addGlobalSecondaryIndex({
      indexName: 'by-student',
      partitionKey: { name: 'studentId', type: ddb.AttributeType.STRING },
      sortKey: { name: 'date', type: ddb.AttributeType.STRING },
      readCapacity: TABLE_CAPACITY.byStudentIndex.read,
      writeCapacity: TABLE_CAPACITY.byStudentIndex.write,
    });
    const usageTable = table('UsageTable', 'month'); // Rekognition calls per month (free-tier guard)

    // ---------------------------------------------------------------- Rekognition + SNS
    const collection = new rekognition.CfnCollection(this, 'FaceCollection', { collectionId: COLLECTION_ID });
    const studentAlerts = new sns.Topic(this, 'LowAttendanceTopic', { displayName: 'CloudAttend' });
    const opsTopic = new sns.Topic(this, 'OpsAlertsTopic', { displayName: 'CloudAttend ops' });
    if (alertEmail) opsTopic.addSubscription(new subs.EmailSubscription(alertEmail));

    // ---------------------------------------------------------------- Cognito
    const pool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'cloudattend-users',
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Immutable so a student can never re-point their own token at someone else's records.
      customAttributes: { studentId: new cognito.StringAttribute({ minLen: 1, maxLen: 40, mutable: false }) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Your CloudAttend account',
        emailBody: 'Hello,<br><br>A CloudAttend account was created for you.<br>'
          + 'Username: {username}<br>Temporary password: {####}<br><br>'
          + `Sign in at ${webUrl} and choose a new password.`,
      },
      removalPolicy,
    });
    const client = pool.addClient('WebClient', {
      authFlows: { userSrp: true, adminUserPassword: true }, // adminUserPassword: CLI smoke tests only (needs IAM)
      generateSecret: false,
      preventUserExistenceErrors: true,
    });
    new cognito.UserPoolGroup(this, 'TeacherGroup', { userPool: pool, groupName: 'teacher' });
    new cognito.UserPoolGroup(this, 'StudentGroup', { userPool: pool, groupName: 'student' });

    // ---------------------------------------------------------------- Lambdas
    const env: Record<string, string> = {
      STUDENTS_TABLE: studentsTable.tableName,
      CLASSES_TABLE: classesTable.tableName,
      SESSIONS_TABLE: sessionsTable.tableName,
      ATTENDANCE_TABLE: attendanceTable.tableName,
      USAGE_TABLE: usageTable.tableName,
      COLLECTION_ID,
      TOPIC_ARN: studentAlerts.topicArn,
      PHOTOS_BUCKET: photos.bucketName,
      USER_POOL_ID: pool.userPoolId,
      ATTENDANCE_THRESHOLD: threshold,
      MIN_SESSIONS_FOR_ALERT: minSessions,
      FACE_MATCH_THRESHOLD: '90',
      REK_MONTHLY_CAP: rekognitionCap,
      MAX_FACES_PER_PHOTO: maxFacesPerPhoto,
    };
    const makeFn = (id: string, dir: string, opts: Partial<lambda.FunctionProps> = {}) => new lambda.Function(this, id, {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, dir), { exclude: PY_EXCLUDE }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: env,
      logGroup: new logs.LogGroup(this, `${id}Logs`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy }),
      ...opts,
    });

    // process_photo needs Pillow (Linux ARM wheels). Bundle locally with pip; fall back to Docker.
    const processSrc = path.join(LAMBDA_DIR, 'process_photo');
    const processCode = lambda.Code.fromAsset(processSrc, {
      exclude: PY_EXCLUDE,
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        platform: 'linux/arm64',
        command: ['bash', '-c', 'pip install -r requirements.txt -t /asset-output && cp handler.py /asset-output/'],
        local: {
          tryBundle(outputDir: string) {
            const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
            try {
              execSync(
                `"${python}" -m pip install -q -r requirements.txt -t "${outputDir}" `
                + '--platform manylinux_2_28_aarch64 --platform manylinux2014_aarch64 '
                + '--only-binary=:all: --python-version 3.12 --implementation cp --upgrade',
                { cwd: processSrc, stdio: 'inherit' });
              fs.copyFileSync(path.join(processSrc, 'handler.py'), path.join(outputDir, 'handler.py'));
              return true;
            } catch {
              return false;
            }
          },
        },
      },
    });

    const enrollFn = makeFn('EnrollFn', 'enroll', { timeout: cdk.Duration.seconds(60) });
    const processFn = makeFn('ProcessPhotoFn', 'process_photo', {
      code: processCode, memorySize: 1024, timeout: cdk.Duration.minutes(3),
    });
    const apiFn = makeFn('ApiFn', 'api', { timeout: cdk.Duration.seconds(29) });

    // Least privilege: DetectFaces has no resource-level permissions; collection APIs are scoped.
    const detectFaces = new iam.PolicyStatement({ actions: ['rekognition:DetectFaces'], resources: ['*'] });
    enrollFn.addToRolePolicy(detectFaces);
    enrollFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rekognition:IndexFaces', 'rekognition:DeleteFaces'], resources: [collection.attrArn],
    }));
    enrollFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['sns:Subscribe'], resources: [studentAlerts.topicArn] }));
    studentsTable.grantReadWriteData(enrollFn);
    usageTable.grantReadWriteData(enrollFn);
    photos.grantRead(enrollFn, 'enroll/*');

    processFn.addToRolePolicy(detectFaces);
    processFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rekognition:SearchFacesByImage'], resources: [collection.attrArn],
    }));
    photos.grantRead(processFn, 'classes/*');
    studentsTable.grantReadData(processFn);
    classesTable.grantReadData(processFn);
    sessionsTable.grantReadWriteData(processFn);
    attendanceTable.grantReadWriteData(processFn);
    usageTable.grantReadWriteData(processFn);
    studentAlerts.grantPublish(processFn);

    for (const t of [studentsTable, classesTable, sessionsTable, attendanceTable]) t.grantReadWriteData(apiFn);
    usageTable.grantReadData(apiFn);
    photos.grantPut(apiFn);
    photos.grantRead(apiFn, 'classes/*');
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminDeleteUser'],
      resources: [pool.userPoolArn],
    }));

    photos.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(enrollFn),
      { prefix: 'enroll/', suffix: '.jpg' });
    photos.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(processFn),
      { prefix: 'classes/', suffix: '.jpg' });

    // ---------------------------------------------------------------- REST API
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'cloudattend-api',
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ['Authorization', 'Content-Type'],
      },
      // metricsEnabled must be explicitly false (omitting it leaves an old `true` in place):
      // per-method "detailed" metrics are billed as custom metrics. The API-level
      // Count/4xx/5xx/Latency metrics used below are free.
      deployOptions: { stageName: 'prod', throttlingRateLimit: 20, throttlingBurstLimit: 40, metricsEnabled: false },
    });
    // Without these, a 401 from the authorizer reaches the browser as an opaque CORS error.
    const corsHeaders = {
      'Access-Control-Allow-Origin': "'*'",
      'Access-Control-Allow-Headers': "'Authorization,Content-Type'",
    };
    api.addGatewayResponse('Default4xx', { type: apigw.ResponseType.DEFAULT_4XX, responseHeaders: corsHeaders });
    api.addGatewayResponse('Default5xx', { type: apigw.ResponseType.DEFAULT_5XX, responseHeaders: corsHeaders });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Auth', { cognitoUserPools: [pool] });
    const integration = new apigw.LambdaIntegration(apiFn, { scopePermissionToMethod: false });
    for (const [method, routePath] of API_ROUTES) {
      api.root.resourceForPath(routePath).addMethod(method, integration, {
        authorizer, authorizationType: apigw.AuthorizationType.COGNITO,
      });
    }

    // ---------------------------------------------------------------- Frontend deployment
    const hasWebBuild = fs.existsSync(path.join(WEB_DIST, 'index.html'));
    const webSource = hasWebBuild
      ? s3deploy.Source.asset(WEB_DIST, { exclude: ['config.json'] })
      : s3deploy.Source.data('index.html',
        '<!doctype html><meta charset="utf-8"><title>CloudAttend</title>'
        + '<p style="font-family:sans-serif">The CloudAttend frontend has not been built yet. '
        + 'Run <code>npm run deploy</code> in <code>infra/</code>.</p>');
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: webBucket,
      sources: [
        webSource,
        s3deploy.Source.jsonData('config.json', {
          apiUrl: api.url,
          userPoolId: pool.userPoolId,
          userPoolClientId: client.userPoolClientId,
          region: this.region,
        }),
      ],
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });

    // ---------------------------------------------------------------- Monitoring
    const functions: Record<string, lambda.Function> = { Enroll: enrollFn, ProcessPhoto: processFn, Api: apiFn };
    const alarmAction = new cwActions.SnsAction(opsTopic);
    const fiveMin = cdk.Duration.minutes(5);
    const alarms: cw.Alarm[] = [];
    const addAlarm = (id: string, description: string, metric: cw.IMetric) => {
      const alarm = new cw.Alarm(this, id, {
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
      alarms.push(alarm);
    };
    for (const [name, fn] of Object.entries(functions)) {
      addAlarm(`${name}ErrorsAlarm`, `CloudAttend ${name} Lambda reported errors`,
        fn.metricErrors({ period: fiveMin, statistic: 'Sum' }));
    }
    addAlarm('Api5xxAlarm', 'CloudAttend API returned 5xx responses',
      api.metricServerError({ period: fiveMin, statistic: 'Sum' }));

    const perFn = (f: (fn: lambda.Function, label: string) => cw.IMetric) =>
      Object.entries(functions).map(([label, fn]) => f(fn, label));
    const faceMetric = (metricName: string, label: string) => new cw.Metric({
      namespace: 'CloudAttend', metricName, dimensionsMap: { Service: 'ProcessPhoto' },
      statistic: 'Sum', period: cdk.Duration.hours(1), label,
    });
    const dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: 'CloudAttend',
      widgets: [
        [
          new cw.GraphWidget({ title: 'Lambda invocations', width: 8, left: perFn((fn, label) => fn.metricInvocations({ label })) }),
          new cw.GraphWidget({ title: 'Lambda errors', width: 8, left: perFn((fn, label) => fn.metricErrors({ label })) }),
          new cw.GraphWidget({ title: 'Lambda duration p90 (ms)', width: 8, left: perFn((fn, label) => fn.metricDuration({ label, statistic: 'p90' })) }),
        ],
        [
          new cw.GraphWidget({ title: 'API requests', width: 8, left: [api.metricCount({ label: 'Requests' })] }),
          new cw.GraphWidget({ title: 'API errors', width: 8, left: [api.metricClientError({ label: '4xx' }), api.metricServerError({ label: '5xx' })] }),
          new cw.GraphWidget({ title: 'API latency p90 (ms)', width: 8, left: [api.metricLatency({ label: 'p90', statistic: 'p90' })] }),
        ],
        [
          new cw.GraphWidget({
            title: 'Faces per hour', width: 12,
            left: [faceMetric('FacesDetected', 'Faces detected'), faceMetric('StudentsMatched', 'Students matched'), faceMetric('UnmatchedFaces', 'Unknown faces')],
          }),
          new cw.AlarmStatusWidget({ title: 'Alarms', width: 12, alarms }),
        ],
      ],
    });

    // Cost guard: account-wide zero-spend budget. E-mails as soon as any actual charge reaches
    // $0.01, and when the month is forecast to exceed the limit.
    if (alertEmail) {
      const subscribers = [{ subscriptionType: 'EMAIL', address: alertEmail }];
      new budgets.CfnBudget(this, 'ZeroSpendBudget', {
        budget: {
          budgetName: 'cloudattend-zero-spend',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: budgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          // $0.01 as a % of the limit (Budgets' minimum threshold value is 0.1): $1 limit -> 1%.
          { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: Math.max(0.1, 1 / budgetUsd), thresholdType: 'PERCENTAGE' }, subscribers },
          { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers },
        ],
      });
    }

    // ---------------------------------------------------------------- Outputs
    const out = (id: string, value: string) => new cdk.CfnOutput(this, id, { value });
    out('ApiUrl', api.url);
    out('UserPoolId', pool.userPoolId);
    out('UserPoolClientId', client.userPoolClientId);
    out('Region', this.region);
    out('PhotosBucketName', photos.bucketName);
    out('WebUrl', webUrl);
    out('DashboardUrl', `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${dashboard.dashboardName}`);
  }
}
