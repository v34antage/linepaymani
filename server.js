const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

loadDotenv();

const LINEPAY_CHANNEL_ID = process.env.LINEPAY_CHANNEL_ID;
const LINEPAY_CHANNEL_SECRET = process.env.LINEPAY_CHANNEL_SECRET;
const LINEPAY_ENV = process.env.LINEPAY_ENV || 'sandbox';
const RETURN_HOST = process.env.RETURN_HOST || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, 'public');
const LINE_OFFICIAL_ACCOUNT_URL = 'https://line.me/R/ti/p/%40275yblcx';

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
      return sendHtml(res, 200, renderPaymentPage('付款已取消', '請回到點餐頁面重新操作。', 'orange'));
    }

    if (req.method === 'GET') {
      return sendStaticFile(url.pathname, res);
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
    return sendHtml(res, 400, renderPaymentPage('付款資料有誤', '缺少 transactionId 或金額不正確。', 'red'));
  }

  const uri = `/v3/payments/${transactionId}/confirm`;
  const requestBody = {
    amount: Number(amount),
    currency: 'TWD'
  };

  const response = await postLinePay(uri, requestBody);

  if (response.returnCode !== '0000') {
    console.error('LINE Pay confirm rejected:', response);
    return sendHtml(res, 200, renderPaymentPage('付款失敗', `原因：${escapeHtml(response.returnMessage)}`, 'red'));
  }

  return sendHtml(
    res,
    200,
    renderPaymentPage('付款完成', '您的 LINE Pay 付款已成功完成，訂單明細已在剪貼簿中。', 'green', {
      redirectUrl: LINE_OFFICIAL_ACCOUNT_URL,
      redirectSeconds: 3,
      redirectText: '請點擊下方按鈕開啟 LINE 官方帳號，並在對話框中貼上訂單送出。'
    })
  );
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

function sendStaticFile(requestPath, res) {
  const cleanPath = requestPath === '/' ? '/index.html' : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(STATIC_DIR, cleanPath));

  if (!filePath.startsWith(STATIC_DIR)) {
    return sendJson(res, 403, { success: false, message: 'Forbidden' });
  }

  const targetPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(STATIC_DIR, 'index.html');

  fs.readFile(targetPath, (error, content) => {
    if (error) {
      return sendJson(res, 404, { success: false, message: 'Not found' });
    }

    res.writeHead(200, {
      'Content-Type': getContentType(targetPath)
    });
    return res.end(content);
  });
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.jsx': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon'
  };

  return types[extension] || 'application/octet-stream';
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function renderPaymentPage(title, message, color, options = {}) {
  const { redirectUrl, redirectSeconds = 3, redirectText } = options;
  const redirectBlock = redirectUrl
    ? `
        <p style="font-weight: 700; color: #444; line-height: 1.6;">${escapeHtml(redirectText || '請開啟 LINE 官方帳號。')}</p>
        <p style="color: #666;">若瀏覽器允許，<span id="countdown">${redirectSeconds}</span> 秒後會自動開啟 LINE。</p>
        <p style="margin-top: 24px;">
          <a href="${escapeHtml(redirectUrl)}" style="display: inline-block; background: #06C755; color: #fff; font-weight: 800; text-decoration: none; padding: 14px 22px; border-radius: 12px; box-shadow: 0 8px 20px rgba(6, 199, 85, 0.25);">
            開啟 LINE 傳送訂單
          </a>
        </p>
        <p style="font-size: 14px; color: #777;">開啟後請長按輸入框貼上訂單內容。</p>
        <script>
          const redirectUrl = ${JSON.stringify(redirectUrl)};
          let seconds = ${Number(redirectSeconds)};
          const countdown = document.getElementById('countdown');
          const timer = setInterval(() => {
            seconds -= 1;
            if (countdown) countdown.textContent = String(Math.max(seconds, 0));
            if (seconds <= 0) {
              clearInterval(timer);
              window.location.href = redirectUrl;
            }
          }, 1000);
        </script>
      `
    : '';

  return `
    <!doctype html>
    <html lang="zh-Hant">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-align: center; margin: 50px 16px 0;">
        <h1 style="color: ${escapeHtml(color)};">${escapeHtml(title)}</h1>
        <p>${message}</p>
        ${redirectBlock}
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
