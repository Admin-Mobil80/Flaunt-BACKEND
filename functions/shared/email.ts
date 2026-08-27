import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({});

const FROM = process.env.OTP_FROM_EMAIL ?? 'no-reply@flaunt.network';
export const PORTAL_URL = process.env.PORTAL_URL ?? 'https://flaunt.network';

/**
 * One shell for every Flaunt email, so they are recognisably from the same
 * product and a change of tone happens in one place.
 *
 * Inline styles only, and a table-free single column: mail clients strip
 * <style> blocks and Outlook ignores most of what survives. A plain-text part
 * always accompanies it — a text/html-only message scores badly with spam
 * filters and is unreadable to anyone whose client blocks HTML.
 */
export function layout(heading: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `<div style="margin:0;padding:32px 16px;background:#FBF9F5;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E4DED2;padding:32px 30px;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#1F1B16;letter-spacing:.02em;">Flaunt</div>
    <div style="height:1px;background:#E4DED2;margin:20px 0 24px;"></div>
    <h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:24px;line-height:1.3;color:#1F1B16;">${heading}</h1>
    <div style="font-size:15px;line-height:1.65;color:#37312A;">${bodyHtml}</div>
    ${cta ? `<div style="margin:26px 0 6px;">
      <a href="${cta.url}" style="display:inline-block;background:#6E2B2B;color:#FBF9F5;text-decoration:none;
        padding:13px 22px;font-size:15px;font-weight:500;">${cta.label}</a>
    </div>` : ''}
    <div style="height:1px;background:#E4DED2;margin:26px 0 16px;"></div>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#A39A8C;">Flaunt is invitation-only. If this was not meant for you, ignore it and nothing happens.</p>
  </div>
</div>`;
}

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Never throws. Email is a side effect of flows whose primary work — a token
 * debit, a refund — has already been committed transactionally. Letting a
 * delivery failure bubble up would fail the caller, and in a stream handler it
 * would replay the batch and re-run work that already succeeded.
 */
export async function send(mail: Mail): Promise<boolean> {
  try {
    await ses.send(new SendEmailCommand({
      Source: `Flaunt <${FROM}>`,
      Destination: { ToAddresses: [mail.to] },
      Message: {
        Subject: { Data: mail.subject },
        Body: { Text: { Data: mail.text }, Html: { Data: mail.html } },
      },
    }));
    return true;
  } catch (err) {
    console.error(JSON.stringify({ msg: 'email send failed', to: mail.to, subject: mail.subject, err: String(err) }));
    return false;
  }
}

export function invitationEmail(opts: {
  to: string; senderName: string; senderLine: string; inviteId: string; hasAccount: boolean;
}): Mail {
  const { to, senderName, senderLine, inviteId, hasAccount } = opts;
  /**
   * The link carries the invited address so sign-up can prefill it. Without
   * that the recipient retypes an address they never chose, and a single
   * mistyped character silently creates an unrelated account whose OTP goes to
   * a mailbox nobody is watching — which is what happened in testing.
   *
   * It does put the address into CloudFront access logs. The alternative is to
   * carry only inviteId and resolve the address through an unauthenticated
   * lookup, which needs a public API surface that does not exist yet.
   */
  const link = `${PORTAL_URL}/?invite=${encodeURIComponent(inviteId)}&email=${encodeURIComponent(to)}`
    + (hasAccount ? '&existing=1' : '');

  /**
   * Two quite different messages, because the recipients are in different
   * situations. Someone who already has an account is being asked to connect
   * and needs no explanation of what Flaunt is; telling them to "join" would
   * read as though their account did not exist. Someone new is being asked to
   * join, and needs the premise before the request makes any sense.
   */
  if (hasAccount) {
    return {
      to,
      subject: `${senderName} wants to connect on Flaunt`,
      html: layout(
        `${escapeHtml(senderName)} wants to connect.`,
        `<p style="margin:0 0 12px;">${escapeHtml(senderLine)}</p>
         <p style="margin:0 0 12px;">Sign in to accept, and you will both see each other's full contact details. Declining returns their token &mdash; they will be told you passed, not why.</p>
         <p style="margin:0;">The request is open for seven days.</p>`,
        { label: 'Sign in and respond', url: link }
      ),
      text: `${senderName} wants to connect with you on Flaunt.\n\n${senderLine}\n\n`
        + `Sign in to accept, and you will both see each other's full contact details. `
        + `Declining returns their token.\n\nThe request is open for seven days.\n\n${link}\n`,
    };
  }

  return {
    to,
    subject: `${senderName} invited you to Flaunt`,
    html: layout(
      `${escapeHtml(senderName)} invited you to Flaunt.`,
      `<p style="margin:0 0 12px;">${escapeHtml(senderLine)}</p>
       <p style="margin:0 0 12px;">Flaunt is a small professional network with no feed and no algorithm. You can only join if someone invites you, and they spent a token to do it.</p>
       <p style="margin:0;">The invitation is open for seven days.</p>`,
      { label: 'Accept the invitation', url: link }
    ),
    text: `${senderName} invited you to Flaunt.\n\n${senderLine}\n\n`
      + `Flaunt is a small professional network with no feed and no algorithm. You can only join if someone invites you.\n\n`
      + `The invitation is open for seven days.\n\nAccept: ${link}\n`,
  };
}

export function refundEmail(opts: { to: string; recipientEmail: string; reason: 'EXPIRED' | 'REJECTED' | 'GATEKEEPER_DENIED'; balance?: number }): Mail {
  const { to, recipientEmail, reason } = opts;
  const what = reason === 'EXPIRED'
    ? `did not respond within seven days`
    : (reason === 'REJECTED' ? `declined your invitation` : `was not passed on`);
  return {
    to,
    subject: `Your token has been returned`,
    html: layout(
      'Your token is back.',
      `<p style="margin:0 0 12px;"><strong style="font-weight:500;">${escapeHtml(recipientEmail)}</strong> ${what}, so the token you spent has been returned to your balance.</p>
       <p style="margin:0;">You only pay for connections you actually make.</p>`,
      { label: 'Open Flaunt', url: PORTAL_URL }
    ),
    text: `${recipientEmail} ${what}, so the token you spent has been returned to your balance.\n\n`
      + `You only pay for connections you actually make.\n\n${PORTAL_URL}\n`,
  };
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
