# CloudAttend infrastructure (AWS CDK)

See the [project README](../README.md) for the architecture, deploy steps and costs.

| Command | What it does |
|---|---|
| `npm run build` | type-check the CDK app |
| `npm test` | CDK assertion tests (`test/`) |
| `npm run test:lambda` | Lambda unit tests (`lambda/tests`, needs `../local/.venv`) |
| `npx cdk synth` | synthesize the CloudFormation template |
| `npx cdk diff` | compare with the deployed stack |
| `npm run deploy` | build `../web` and deploy `CloudAttendStack` |
| `npx cdk destroy` | delete everything |
