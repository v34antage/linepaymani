const http = require('http');
const crypto = require('crypto');

loadDotenv();

const LINEPAY_CHANNEL_ID = process.env.LINEPAY_CHANNEL_ID;
const LINEPAY_CHANNEL_SECRET = process.env.LINEPAY_CHANNEL_SECRET;
const LINEPAY_ENV = process.env.LINEPAY_ENV || 'sandbox';
const RETURN_HOST = process.env.RETURN_HOST || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;

if (!LINEPAY_CHANNEL_ID || !LINEPAY_CHANNEL_SECRET) {
  throw new Error('Missing LINEPAY_CHANNEL_ID or LINEPAY_CHANNEL_SECRET in environment variables.');
}

const LINEPAY_SITE =
  LINEPAY_ENV === 'production'
    ? 'https://api-pay.line.me'
    : 'https://sandbox-api-pay.line.me';

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, null);
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        env: LINEPAY_ENV,
        returnHost: RETURN_HOST
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/linepay/request') {
      return await handleLinePayRequest(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/linepay/confirm') {
      return await handleLinePayConfirm(url, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/linepay/cancel') {
      return sendHtml(res, 200, renderPaymentPage('Payment canceled', 'Please return to the order page and try again.', 'orange'));
    }

    return sendJson(res, 404, { success: false, message: 'Not found' });
  } catch (error) {
    console.error('Server error:', error.responseData || error.message);
    return sendJson(res, 500, { success: false, message: 'Server error' });
  }
});

async function handleLinePayRequest(req, res) {
  const { amount, orderId, packages } = await readJson(req);

  if (!Number.isInteger(Number(amount)) || Number(amount) <= 0) {
    return sendJson(res, 400, { success: false, message: 'amount must be a positive integer.' });
  }

  if (!orderId || !Array.isArray(packages) || packages.length === 0) {
    return sendJson(res, 400, { success: false, message: 'orderId and packages are required.' });
  }

  const uri = '/v3/payments/request';
  const requestBody = {
    amount: Number(amount),
    currency: 'TWD',
    orderId,
    packages,
    redirectUrls: {
      confirmUrl: `${RETURN_HOST}/api/linepay/confirm?amount=${Number(amount)}`,
      cancelUrl: `${RETURN_HOST}/api/linepay/cancel`
    }
  };

  const response = await postLinePay(uri, requestBody);

  if (response.returnCode !== '0000') {
    console.error('LINE Pay request rejected:', response);
    return sendJson(res, 400, {
      success: false,
      message: response.returnMessage,
      code: response.returnCode
    });
  }

  return sendJson(res, 200, {
    success: true,
    paymentUrl: response.info.paymentUrl.web,
    transactionId: response.info.transactionId
  });
}

async function handleLinePayConfirm(url, res) {
  const transactionId = url.searchParams.get('transactionId');
  const amount = url.searchParams.get('amount');

  if (!transactionId || !Number.isInteger(Number(amount)) || Number(amount) <= 0) {
    return sendHtml(res, 400, renderPaymentPage('Invalid payment data', 'Missing transactionId or invalid amount.', 'red'));
  }

  const uri = `/v3/payments/${transactionId}/confirm`;
  const requestBody = {
    amount: Number(amount),
    currency: 'TWD'
  };

  const response = await postLinePay(uri, requestBody);

  if (response.returnCode !== '0000') {
    console.error('LINE Pay confirm rejected:', response);
    return sendHtml(res, 200, renderPaymentPage('Payment failed', `Reason: ${escapeHtml(response.returnMessage)}`, 'red'));
  }

  return sendHtml(res, 200, renderPaymentPage('Payment complete', 'Your order payment was completed successfully.', 'green'));
}

async function postLinePay(uri, requestBody) {
  const response = await fetch(`${LINEPAY_SITE}${uri}`, {
    method: 'POST',
    headers: createLinePayHeaders(uri, requestBody),
    body: JSON.stringify(requestBody)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`LINE Pay API returned HTTP ${response.status}`);
    error.responseData = data;
    throw error;
  }

  return data;
}

function createLinePayHeaders(uri, requestBody) {
  const nonce = crypto.randomUUID();

  return {
    'Content-Type': 'application/json',
    'X-LINE-ChannelId': LINEPAY_CHANNEL_ID,
    'X-LINE-Authorization-Nonce': nonce,
    'X-LINE-Authorization': createSignature(uri, requestBody, nonce)
  };
}

function createSignature(uri, requestBody, nonce) {
  const body = requestBody ? JSON.stringify(requestBody) : '';
  const stringToSign = LINEPAY_CHANNEL_SECRET + uri + body + nonce;

  return crypto
    .createHmac('sha256', LINEPAY_CHANNEL_SECRET)
    .update(stringToSign)
    .digest('base64');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Request body is too large.'));
      }
    });

    req.on('end', () => {
      if (!body) {
        return resolve({});
      }

      try {
        return resolve(JSON.parse(body));
      } catch (error) {
        return reject(new Error('Invalid JSON request body.'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });

  if (payload === null) {
    return res.end();
  }

  return res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8'
  });
  return res.end(html);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function renderPaymentPage(title, message, color) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: ${color};">${escapeHtml(title)}</h1>
        <p>${message}</p>
      </body>
    </html>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function loadDotenv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');

    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

server.listen(PORT, () => {
  console.log(`LINE Pay server is running on port ${PORT}.`);
  console.log(`LINE Pay environment: ${LINEPAY_ENV}`);
  console.log(`Return host: ${RETURN_HOST}`);
});
