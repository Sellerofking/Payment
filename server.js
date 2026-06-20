const express = require('express');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(cookieParser()); // PHP session ka alternative

// Webhook payload ko raw format me read karne ke liye
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. INDEX PAGE & PAYMENT LOGIC
// ==========================================
app.get('/', (req, res) => {
    res.send(renderIndexHtml());
});

app.post('/pay', async (req, res) => {
    try {
        const successUrl = encodeURIComponent(process.env.SUCCESS_URL);
        const apiUrl = `https://xwalletbot.shop/wallet/getway/pay.php?key=${process.env.API_KEY}&amount=${process.env.PAY_AMOUNT}&redirect_url=${successUrl}`;
        
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.payment_link && data.order_id) {
            // PHP Session ki jagah Cookie me order_id save kar rahe hain
            res.cookie('my_order_id', data.order_id, { maxAge: 900000, httpOnly: true });
            res.redirect(data.payment_link);
        } else {
            res.send(renderIndexHtml("Payment link generate nahi ho paya. Kripya try karein."));
        }
    } catch (error) {
        res.send(renderIndexHtml("Server se connect nahi ho paya. Gateway down hai."));
    }
});

// ==========================================
// 2. WEBHOOK RECEIVER (100% PHP Logic Match)
// ==========================================
app.post('/webhook', async (req, res) => {
    const rawPayload = req.rawBody;
    const receivedSignature = req.headers['x-xwallet-signature'] || '';
    
    const calculatedSignature = crypto.createHmac('sha256', process.env.SECRET_KEY).update(rawPayload).digest('hex');
    const data = req.body;

    if (receivedSignature !== calculatedSignature) {
        const bodySecret = data.secret_key || data.secret || '';
        if (bodySecret !== process.env.SECRET_KEY) {
            return res.status(401).json({ status: "error", message: "Invalid Security Signature!" });
        }
    }

    const paymentStatus = data.status ? data.status.toUpperCase() : '';
    const amount = parseFloat(data.amount || 0);
    const orderId = data.order_id || 'Unknown';

    if ((paymentStatus === 'SUCCESS' || paymentStatus === 'TXN_SUCCESS') && amount == parseFloat(process.env.PAY_AMOUNT)) {
        try {
            // Same as PHP md5(uniqid) format: XXXX-XXXX-XXXX-XXXX
            const newCard = crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
            
            await db.execute(
                "INSERT INTO single_card (card, value, type, mark, usable, soft_id) VALUES (?, 1, 5, ?, 1, ?)",
                [newCard, `OrderID: ${orderId}`, process.env.SOFT_ID]
            );
            return res.json({ status: "ok", message: "Card generated" });
        } catch (error) {
            console.error(error);
            return res.status(500).send("DB Error");
        }
    } else {
        return res.json({ status: "ignored" });
    }
});

// ==========================================
// 3. SUCCESS PAGE
// ==========================================
app.get('/success', async (req, res) => {
    // Session ki jagah Cookie se Order ID nikalna
    const orderId = req.cookies.my_order_id;

    if (!orderId) {
        return res.send("<div style='background:#0f1319; color:#fff; text-align:center; padding:50px; font-family:sans-serif; height:100vh;'><h2>❌ Invalid Access</h2></div>");
    }

    let cardKey = "WAITING";
    try {
        const [rows] = await db.execute(
            "SELECT card FROM single_card WHERE mark = ? ORDER BY id DESC LIMIT 1",
            [`OrderID: ${orderId}`]
        );

        if (rows.length > 0) {
            cardKey = rows[0].card;
        } else {
            cardKey = "WAITING";
        }
    } catch (error) {
        cardKey = "ERROR";
    }

    res.send(renderSuccessHtml(orderId, cardKey));
});

// ==========================================
// EXACT UI TEMPLATES (HTML/CSS)
// ==========================================
function renderIndexHtml(errorMsg = null) {
    let errorHtml = errorMsg ? `<div class="error-msg"><i class="fas fa-exclamation-triangle"></i> ${errorMsg}</div>` : '';
    let payAmount = parseInt(process.env.PAY_AMOUNT).toLocaleString('en-IN');
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Trust - Secure Payment</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #0f1319; color: #ffffff; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 15px; }
        .payment-card { background-color: #181d29; width: 100%; max-width: 400px; border-radius: 16px; padding: 25px 20px; border: 1px solid #232a3b; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .brand-icon { width: 45px; height: 45px; background: #000; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1px solid #333; }
        .brand-text h3 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.5px; }
        .brand-text p { margin: 0; font-size: 13px; color: #8a95a5; margin-top: 2px; }
        .tag { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 6px 12px; border-radius: 8px; font-size: 12px; color: #8a95a5; }
        .amount-section { text-align: center; margin-bottom: 20px; }
        .amount-section p { font-size: 12px; color: #8a95a5; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 10px; font-weight: 500;}
        .amount-section h1 { font-size: 48px; margin: 0; font-weight: 700; display: flex; justify-content: center; align-items: center; }
        .amount-section .pay-to { font-size: 14px; color: #8a95a5; margin-top: 10px; letter-spacing: 0.5px; }
        .amount-section .pay-to strong { color: #fff; font-weight: 600; }
        .divider { height: 3px; background: #3b82f6; border-radius: 2px; margin: 25px 0; width: 100%; box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);}
        .status-box { background: #131722; border: 1px solid #232a3b; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 10px; font-size: 14px; margin-bottom: 25px; color: #eab308; }
        .status-dot { width: 8px; height: 8px; background: #eab308; border-radius: 50%; box-shadow: 0 0 8px #eab308; }
        .pay-btn { background-color: #ffffff; color: #000000; border: none; padding: 16px; font-size: 16px; font-weight: 700; border-radius: 12px; width: 100%; cursor: pointer; transition: 0.2s ease; display: flex; justify-content: center; align-items: center; gap: 10px; }
        .pay-btn:active { transform: scale(0.98); }
        .footer { text-align: center; margin-top: 25px; font-size: 12px; color: #8a95a5; display: flex; justify-content: space-between; align-items: center; padding: 0 5px;}
        .footer .secure { color: #10b981; display: flex; align-items: center; gap: 5px; }
        .error-msg { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; padding: 12px; border-radius: 8px; font-size: 14px; margin-bottom: 15px; text-align: center; }
    </style>
</head>
<body>
    <div class="payment-card">
        <div class="header">
            <div class="brand">
                <div class="brand-icon"><i class="fas fa-shield-alt" style="color: #10b981; font-size: 20px;"></i></div>
                <div class="brand-text"><h3>Trust</h3><p>Secure Payment</p></div>
            </div>
            <div class="tag">Premium</div>
        </div>
        ${errorHtml}
        <div class="amount-section">
            <p>Amount to pay</p>
            <h1>₹${payAmount}</h1>
            <div class="pay-to">Pay to: <strong>X WALLET PAYMENT GETWAY</strong></div>
        </div>
        <div class="divider"></div>
        <div class="status-box">
            <div class="status-dot"></div><span>Ready for payment...</span>
        </div>
        <form method="POST" action="/pay" id="payForm">
            <button type="submit" class="pay-btn" id="payBtn">
                <i class="fas fa-qrcode"></i> Proceed to Pay & Get Key
            </button>
        </form>
        <div class="footer">
            <div class="secure"><i class="fas fa-lock"></i> 100% Secure</div>
            <div>Powered by Trust</div>
        </div>
    </div>
    <script>
        document.getElementById('payForm').addEventListener('submit', function() {
            var btn = document.getElementById('payBtn');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting Gateway...';
            btn.style.opacity = '0.7';
            btn.style.pointerEvents = 'none';
        });
    </script>
</body>
</html>`;
}

function renderSuccessHtml(orderId, cardKey) {
    let orderShort = String(orderId).substring(0, 8);
    let dynamicContent = '';

    if (cardKey === "WAITING") {
        dynamicContent = `
            <div class="status-box" style="color: #eab308;">
                <i class="fas fa-circle-notch fa-spin"></i> Generating License Key...
            </div>
            <button class="btn-action btn-refresh" onclick="location.reload();">
                <i class="fas fa-sync-alt"></i> Refresh Status
            </button>
        `;
    } else if (cardKey === "ERROR") {
        dynamicContent = `
            <div class="status-box" style="color: #ef4444; border-color: rgba(239, 68, 68, 0.3);">
                <i class="fas fa-times-circle"></i> Database Error Occurred
            </div>
        `;
    } else {
        dynamicContent = `
            <div class="status-box" style="color: #10b981; border-color: rgba(16, 185, 129, 0.3);">
                <i class="fas fa-check-circle"></i> Key Generated Successfully
            </div>
            <div class="key-container">
                <div class="key-text" id="myKey">${cardKey}</div>
            </div>
            <button class="btn-action" id="copyBtn" onclick="copyKey()">
                <i class="fas fa-copy"></i> Copy Premium Key
            </button>
        `;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Payment Successful</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #0f1319; color: #ffffff; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 15px; }
        .payment-card { background-color: #181d29; width: 100%; max-width: 400px; border-radius: 16px; padding: 25px 20px; border: 1px solid #232a3b; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .brand-icon { width: 45px; height: 45px; background: rgba(16, 185, 129, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(16, 185, 129, 0.3); }
        .brand-text h3 { margin: 0; font-size: 16px; font-weight: 600; }
        .brand-text p { margin: 0; font-size: 13px; color: #8a95a5; margin-top: 2px; }
        .tag { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 6px 10px; border-radius: 8px; font-size: 12px; color: #8a95a5; letter-spacing: 0.5px;}
        .divider { height: 3px; background: #10b981; border-radius: 2px; margin: 20px 0; width: 100%; box-shadow: 0 0 10px rgba(16, 185, 129, 0.3);}
        .status-box { background: #131722; border: 1px solid #232a3b; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 10px; font-size: 14px; margin-bottom: 25px; }
        .key-container { background: #0f1319; border: 1px dashed #3b82f6; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 20px; }
        .key-text { font-size: 18px; font-weight: 700; color: #fff; letter-spacing: 2px; word-break: break-all; }
        .btn-action { background-color: #3b82f6; color: #fff; border: none; padding: 15px; font-size: 15px; font-weight: 600; border-radius: 10px; width: 100%; cursor: pointer; transition: 0.2s ease; display: flex; justify-content: center; align-items: center; gap: 8px; }
        .btn-action:active { transform: scale(0.98); }
        .btn-refresh { background-color: #232a3b; color: #fff; margin-top: 10px; }
        .footer { text-align: center; margin-top: 25px; font-size: 12px; color: #8a95a5; display: flex; justify-content: space-between; align-items: center; padding: 0 5px;}
        .footer .secure { color: #10b981; display: flex; align-items: center; gap: 5px; }
    </style>
</head>
<body>
    <div class="payment-card">
        <div class="header">
            <div class="brand">
                <div class="brand-icon">
                    <i class="fas fa-check" style="color: #10b981; font-size: 20px;"></i>
                </div>
                <div class="brand-text">
                    <h3>Trust</h3>
                    <p>Payment Success</p>
                </div>
            </div>
            <div class="tag">#${orderShort}</div>
        </div>
        <div class="divider"></div>
        
        ${dynamicContent}

        <div class="footer">
            <div class="secure"><i class="fas fa-lock"></i> 100% Secure</div>
            <div>Powered by Trust</div>
        </div>
    </div>
    <script>
        function copyKey() {
            var keyText = document.getElementById("myKey").innerText;
            navigator.clipboard.writeText(keyText).then(function() {
                var btn = document.getElementById('copyBtn');
                btn.innerHTML = '<i class="fas fa-check-double"></i> Copied to Clipboard!';
                btn.style.backgroundColor = '#10b981';
                setTimeout(function() {
                    btn.innerHTML = '<i class="fas fa-copy"></i> Copy Premium Key';
                    btn.style.backgroundColor = '#3b82f6';
                }, 2000);
            });
        }
    </script>
</body>
</html>`;
}

module.exports = app;
