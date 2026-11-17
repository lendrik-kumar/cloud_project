#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CloudAttendStack } from '../lib/cloudattend-stack';

const app = new cdk.App();
new CloudAttendStack(app, 'CloudAttendStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-south-1' },
  description: 'CloudAttend: serverless face-recognition attendance (UCS531)',
});
