import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { flauntZone } from './zone';

export interface CertStackProps extends StackProps {
  domainNames: string[];
}

/**
 * CloudFront only accepts ACM certificates issued in us-east-1, whatever region
 * the rest of the app lives in — hence a stack of its own, pinned there.
 *
 * domainNames[0] becomes the certificate's primary DomainName and the rest are
 * SANs. Changing which name is first forces a replacement all on its own, so the
 * order here is deliberate and should not be shuffled.
 */
export class CertStack extends Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainNames[0],
      subjectAlternativeNames: props.domainNames.slice(1),
      // Writes the validation CNAMEs straight into the zone. This is why the
      // registrar delegation has to be correct before deploying: if it is not,
      // this resource sits in CREATE_IN_PROGRESS until CloudFormation times out.
      validation: acm.CertificateValidation.fromDns(flauntZone(this)),
    });

    new CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}
