import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { API_ROUTES, CloudAttendStack, TABLE_CAPACITY } from '../lib/cloudattend-stack';

function synth(context: Record<string, unknown> = {}): Template {
  // Skip Lambda bundling (pip/Docker) in unit tests.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const stack = new CloudAttendStack(app, 'TestStack', { env: { account: '123456789012', region: 'ap-south-1' } });
  return Template.fromStack(stack);
}

const statements = (t: Template): any[] =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
const actionsOf = (s: any): string[] => [].concat(s.Action);

describe('CloudAttendStack', () => {
  const t = synth();

  test('core resources exist', () => {
    t.resourceCountIs('AWS::DynamoDB::Table', 5);
    t.resourceCountIs('AWS::Rekognition::Collection', 1);
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    const appFns = t.findResources('AWS::Lambda::Function', {
      Properties: { Handler: 'handler.handler', Runtime: 'python3.12', Architectures: ['arm64'] },
    });
    expect(Object.keys(appFns)).toHaveLength(3);
  });

  test('DynamoDB stays inside the always-free 25 RCU / 25 WCU', () => {
    let read = 0;
    let write = 0;
    for (const table of Object.values(t.findResources('AWS::DynamoDB::Table')) as any[]) {
      const p = table.Properties;
      expect(p.ProvisionedThroughput).toBeDefined(); // no on-demand (pay-per-request) tables
      read += p.ProvisionedThroughput.ReadCapacityUnits;
      write += p.ProvisionedThroughput.WriteCapacityUnits;
      for (const gsi of p.GlobalSecondaryIndexes ?? []) {
        read += gsi.ProvisionedThroughput.ReadCapacityUnits;
        write += gsi.ProvisionedThroughput.WriteCapacityUnits;
      }
    }
    expect(read).toBeLessThanOrEqual(25);
    expect(write).toBeLessThanOrEqual(25);
    const declared = Object.values(TABLE_CAPACITY);
    expect(read).toBe(declared.reduce((n, c) => n + c.read, 0));
    t.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0); // its alarms aren't free
  });

  test('no paid CloudWatch extras', () => {
    // Detailed API metrics are billed per method; free tier is 10 alarms / 3 dashboards.
    t.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: [Match.objectLike({ MetricsEnabled: false })],
    });
    expect(Object.keys(t.findResources('AWS::CloudWatch::Alarm')).length).toBeLessThanOrEqual(10);
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  test('every bucket blocks public access and enforces TLS', () => {
    const buckets = t.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(2);
    for (const b of Object.values(buckets)) {
      expect((b as any).Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      });
    }
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      })]) },
    });
  });

  test('every API method (except CORS preflight) requires Cognito', () => {
    const methods = Object.values(t.findResources('AWS::ApiGateway::Method')) as any[];
    const real = methods.filter((m) => m.Properties.HttpMethod !== 'OPTIONS');
    expect(real).toHaveLength(API_ROUTES.length);
    for (const m of real) expect(m.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
  });

  test('photo bucket CORS is limited to the dashboard and local dev', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: { CorsRules: [Match.objectLike({
        AllowedMethods: ['PUT'],
        AllowedOrigins: Match.arrayWith(['http://localhost:5173']),
      })] },
    });
    const origins = JSON.stringify(t.findResources('AWS::S3::Bucket'));
    expect(origins).not.toContain('"AllowedOrigins":["*"]');
  });

  test('Rekognition collection APIs are scoped to the collection', () => {
    const rek = statements(t).filter((s) => actionsOf(s).some((a) => a.startsWith('rekognition:')));
    expect(rek.length).toBeGreaterThan(0);
    for (const s of rek) {
      if (actionsOf(s).some((a) => a !== 'rekognition:DetectFaces')) expect(s.Resource).not.toBe('*');
    }
  });

  test('students cannot change their own studentId', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([Match.objectLike({ Name: 'studentId', Mutable: false })]),
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  test('error alarms notify the ops topic', () => {
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as any[];
    expect(alarms).toHaveLength(4); // 3 Lambdas + API 5xx
    for (const a of alarms) expect(a.Properties.AlarmActions).toHaveLength(1);
  });

  test('budget and ops e-mail only when alertEmail is set', () => {
    t.resourceCountIs('AWS::Budgets::Budget', 0);
    t.resourceCountIs('AWS::SNS::Subscription', 0);
    synth({ alertEmail: 'ops@example.com' }).hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetLimit: { Amount: 1 } }, // default $1 limit -> alert at 1% = $0.01
      NotificationsWithSubscribers: Match.arrayWith([Match.objectLike({ Notification: Match.objectLike({ Threshold: 1 }) })]),
    });

    const withEmail = synth({ alertEmail: 'ops@example.com', monthlyBudgetUsd: '10' });
    withEmail.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetLimit: { Amount: 10, Unit: 'USD' }, TimeUnit: 'MONTHLY' },
      NotificationsWithSubscribers: Match.arrayWith([Match.objectLike({
        Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 0.1, ThresholdType: 'PERCENTAGE' },
      })]),
    });
    withEmail.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  test('attendance settings come from context', () => {
    const custom = synth({ attendanceThreshold: '80', minSessionsForAlert: '1', rekognitionMonthlyCap: '100' });
    custom.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({
        ATTENDANCE_THRESHOLD: '80', MIN_SESSIONS_FOR_ALERT: '1', REK_MONTHLY_CAP: '100', MAX_FACES_PER_PHOTO: '50',
      }) },
    });
  });
});
