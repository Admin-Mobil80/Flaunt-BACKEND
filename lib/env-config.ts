export type EnvName = 'dev' | 'prod';

export interface EnvProps {
  readonly envName: EnvName;
}

/**
 * Suffix used in resource names — S3 bucket names cannot contain underscores,
 * so it gets a hyphenated variant while everything else (Lambda, DynamoDB,
 * Cognito, AppSync) uses the literal `_dev`/`_prod`.
 */
export function suffix(envName: EnvName): string {
  return `_${envName}`;
}

export function s3Suffix(envName: EnvName): string {
  return `-${envName}`;
}

export function subdomainPrefix(envName: EnvName): string {
  return envName === 'dev' ? 'dev.' : '';
}
