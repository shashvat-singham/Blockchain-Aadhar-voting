'use strict';

const { env } = require('./env');
const { unavailable } = require('./http');

/**
 * OTP delivery. Pluggable so the deployment picks a provider through
 * OTP_TRANSPORT rather than a code change:
 *
 *   console -> writes the code to the platform log (local development)
 *   twilio  -> Twilio Programmable Messaging
 *   msg91   -> MSG91, common for Indian DLT-registered senders
 *
 * The old implementation used Firebase phone auth in the browser, which meant
 * shipping a Firebase project config to every visitor and depending on a
 * third-party SDK at page load. Delivery now happens entirely server-side.
 */

function messageFor(otp) {
  const minutes = Math.max(1, Math.round(env.otpTtlSeconds / 60));
  return `${otp} is your verification code for the Aadhaar Voting portal. It expires in ${minutes} minute(s). Do not share it with anyone.`;
}

async function sendViaTwilio(phone, otp) {
  if (!env.twilioAccountSid || !env.twilioAuthToken || !env.twilioFromNumber) {
    throw unavailable('SMS delivery is not configured (missing Twilio credentials)');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`;
  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: phone, From: env.twilioFromNumber, Body: messageFor(otp) }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // The code itself is never logged on the failure path.
    console.error(`Twilio delivery failed (${response.status}): ${detail.slice(0, 500)}`);
    throw unavailable('Could not send the verification code. Please try again.');
  }
}

async function sendViaMsg91(phone, otp) {
  if (!env.msg91AuthKey || !env.msg91TemplateId) {
    throw unavailable('SMS delivery is not configured (missing MSG91 credentials)');
  }

  const response = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { authkey: env.msg91AuthKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_id: env.msg91TemplateId,
      mobile: phone.replace(/^\+/, ''),
      sender: env.msg91SenderId || undefined,
      otp,
      otp_expiry: Math.max(1, Math.round(env.otpTtlSeconds / 60)),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.type === 'error') {
    console.error(`MSG91 delivery failed (${response.status}):`, payload?.message);
    throw unavailable('Could not send the verification code. Please try again.');
  }
}

/**
 * @param {string} phone E.164 destination.
 * @param {string} otp The one-time code.
 * @returns {Promise<{ transport: string, echoed: boolean }>} `echoed` is true
 *          only when the caller may show the code in the UI (dev mode).
 */
async function sendOtp(phone, otp) {
  switch (env.otpTransport) {
    case 'twilio':
      await sendViaTwilio(phone, otp);
      return { transport: 'twilio', echoed: false };

    case 'msg91':
      await sendViaMsg91(phone, otp);
      return { transport: 'msg91', echoed: false };

    case 'console':
    default: {
      if (env.isProduction) {
        // Refuse to run an election where codes only exist in a log file.
        throw unavailable(
          'SMS delivery is not configured. Set OTP_TRANSPORT to twilio or msg91 before going live.'
        );
      }
      console.info(`[dev] OTP for ${phone}: ${otp}`);
      return { transport: 'console', echoed: env.devEchoOtp };
    }
  }
}

module.exports = { sendOtp };
