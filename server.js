const express = require('express');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(cookieParser());

// Raw payload read karna HMAC check ke liye zaroori hai
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// CENTRAL CONFIGURATION (Dynamic from Vercel Env)
// ==========================================
let PLAN_RATES = {};
try {
    // Vercel me {"50":1, "300":15, "500":30} JSON string format me pass hoga
    PLAN_RATES = JSON.parse(process.env.PLAN_RATES || '{"50":1,"300":15,"500":30}');
} catch (e) {
    console.error("PLAN_RATES environment variable is not valid JSON.");
}

// ==========================================
// 1. INDEX PAGE & PAYMENT LOGIC
// ==========================================
app.get('/', (req, res) => {
    res.send(renderIndexHtml());
});

app.post('/', async (req, res) => {
    try {
        const selectedAmount = req.body.amount;
        
        // Security Check: Only allow amounts defined in Vercel Env
        if (!PLAN_RATES.hasOwnProperty(selectedAmount)) {
            return res.send(renderIndexHtml("Please select a valid plan."));
        }

        const successUrl = encodeURIComponent(process.env.SUCCESS_URL);
        const apiUrl = `https://xwalletbot.shop/wallet/getway/pay.php?key=${process.env.API_KEY}&amount=${selectedAmount}&redirect_url=${successUrl}`;
        
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.payment_link && data.order_id) {
            res.cookie('my_order_id', data.order_id, { maxAge: 900000, httpOnly: true });
            res.redirect(data.payment_link);
        } else {
            res.send(renderIndexHtml("Payment link generation failed. Please try again."));
        }
    } catch (error) {
        res.send(renderIndexHtml("Unable to connect to the server. Gateway might be down."));
    }
});

// ==========================================
// 2. WEBHOOK RECEIVER (Exact PHP Security Logic)
// ==========================================
app.post('/webhook', async (req, res) => {
    console.log(`\n--- NEW WEBHOOK HIT: ${new Date().toISOString()} ---`);
    
    const rawPayload = req.rawBody;
    console.log("PAYLOAD DATA:", rawPayload);

    const receivedSignature = req.headers['x-xwallet-signature'] || '';
    const data = req.body;

    // Security Check 1: Calculate HMAC
    const calculatedSignature = crypto.createHmac('sha256', process.env.SECRET_KEY).update(rawPayload).digest('hex');

    // Security Check 2: Verify Signature strictly (Same as your webhook.php)
    let isSecure = false;
    if (receivedSignature !== '' && calculatedSignature === receivedSignature) {
        isSecure = true;
    } else {
        const bodySecret = data.secret_key || data.secret || '';
        if (bodySecret === process.env.SECRET_KEY && process.env.SECRET_KEY !== '') {
            isSecure = true;
        }
    }

    if (!isSecure) {
        console.log("🚨 HACK ATTEMPT BLOCKED: Invalid Security Signature!");
        return res.status(401).json({ status: "error", message: "Unauthorized Access!" });
    }

    console.log("SUCCESS ✅: Security verification passed!");

    const paymentStatus = data.status ? data.status.toUpperCase() : '';
    const amount = parseFloat(data.amount || 0);
    const orderId = data.order_id ? data.order_id.trim() : '';
    const rawTxnId = data.txn_id ? data.txn_id.trim() : '';
    const shortTxnId = rawTxnId.length > 8 ? rawTxnId.substring(8) : rawTxnId;

    // Stop if order id is empty (Bypass prevention)
    if (!orderId) {
        console.log("ERROR ❌: Order ID is missing.");
        return res.status(400).json({ status: "error", message: "Missing Order ID" });
    }

    let duration = 0;
    if (PLAN_RATES.hasOwnProperty(amount)) {
        duration = PLAN_RATES[amount];
    }

    if ((paymentStatus === 'SUCCESS' || paymentStatus === 'TXN_SUCCESS') && duration > 0) {
        const lockName = `webhook_${orderId}`;
        let connection;

        try {
            connection = await db.getConnection();

            const [lockResult] = await connection.execute("SELECT GET_LOCK(?, 10) as acquired", [lockName]);
            if (!lockResult[0].acquired) {
                console.log(`IGNORED ⚠️: Could not acquire lock for ${orderId}.`);
                return res.json({ status: "ok", message: "Already processing" });
            }

            const markNote = `OrderID: ${orderId} | Txn: ${shortTxnId}`;

            const [checkRows] = await connection.execute("SELECT COUNT(*) as count FROM single_card WHERE mark = ?", [markNote]);
            if (checkRows[0].count > 0) {
                console.log(`IGNORED ⚠️: Duplicate Webhook. Key already generated for ${orderId}.`);
                return res.json({ status: "ok", message: "Already processed" });
            }

            const newCard = crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');

            await connection.execute(
                "INSERT INTO single_card (card, value, type, mark, usable, soft_id) VALUES (?, ?, 3, ?, 1, ?)",
                [newCard, duration, markNote, process.env.SOFT_ID]
            );

            console.log(`SUCCESS 💰: Payment verified & Database inserted. Plan: ${duration} Days | Key: ${newCard}`);
            return res.json({ status: "ok", message: "Card generated" });

        } catch (error) {
            console.error("DB ERROR ❌:", error.message);
            return res.status(500).send("Database Error");
        } finally {
            if (connection) {
                await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
                connection.release();
            }
        }
    } else {
        console.log(`IGNORED ⚠️: Status (${paymentStatus}) not success or Invalid Amount (${amount}).`);
        return res.json({ status: "ignored" });
    }
});

// ==========================================
// 3. SUCCESS PAGE
// ==========================================
app.get('/success', async (req, res) => {
    let orderId = req.cookies.my_order_id || req.query.order_id || '';

    if (!orderId) {
        return res.send("<div style='background:#0f1319; color:#fff; text-align:center; padding:50px; font-family:sans-serif; height:100vh;'><h2>❌ Invalid Access</h2></div>");
    }

    if (!req.cookies.my_order_id) {
        res.cookie('my_order_id', orderId, { maxAge: 900000, httpOnly: true });
    }

    let cardKey = "WAITING";
    try {
        const [rows] = await db.execute(
            "SELECT card FROM single_card WHERE mark = ? ORDER BY id DESC LIMIT 1",
            [`OrderID: ${orderId}`]
        );

        if (rows.length > 0) {
            cardKey = rows[0].card;
        }
    } catch (error) {
        cardKey = "ERROR";
    }

    res.send(renderSuccessHtml(orderId, cardKey));
});

// ==========================================
// EXACT HTML/CSS UI TEMPLATES
// ==========================================
function renderIndexHtml(errorMsg = null) {
    let errorHtml = errorMsg ? `<div class="error-msg"><i class="fas fa-exclamation-triangle"></i> ${errorMsg}</div>` : '';
    let plansHtml = '';
    let isFirst = true;
    
    // Dynamic looping of plans
    for (const [price, days] of Object.entries(PLAN_RATES)) {
        let title = (days === 1) ? "1 Day" : `${days} Days`;
        plansHtml += `
        <label class="plan-option ${isFirst ? 'selected' : ''}">
            <input type="radio" name="amount" value="${price}" ${isFirst ? 'checked' : ''}>
            <div class="plan-title">${title}</div>
            <div class="plan-price">₹${price}</div>
        </label>`;
        isFirst = false;
    }

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
        .brand-text h3 { margin: 0; font-size: 16px; font-weight: 600; }
        .brand-text p { margin: 0; font-size: 13px; color: #8a95a5; margin-top: 2px; }
        .tag { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 6px 12px; border-radius: 8px; font-size: 12px; color: #8a95a5; }
        .plan-selector { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
        .plan-option { display: flex; justify-content: space-between; align-items: center; background: #131722; border: 1px solid #232a3b; padding: 15px; border-radius: 10px; cursor: pointer; transition: 0.2s; }
        .plan-option:hover { border-color: #3b82f6; }
        .plan-option input[type="radio"] { display: none; }
        .plan-option.selected { border-color: #3b82f6; background: rgba(59, 130, 246, 0.1); }
        .plan-title { font-weight: 600; font-size: 15px; }
        .plan-price { font-size: 16px; font-weight: 700; color: #10b981; }
        .divider { height: 3px; background: #3b82f6; border-radius: 2px; margin: 25px 0; width: 100%; box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);}
        .pay-btn { background-color: #ffffff; color: #000000; border: none; padding: 16px; font-size: 16px; font-weight: 700; border-radius: 12px; width: 100%; cursor: pointer; transition: 0.2s ease; display: flex; justify-content: center; align-items: center; gap: 10px; }
        .pay-btn:active { transform: scale(0.98); }
        .contact-us { text-align: center; margin-top: 20px; font-size: 13px; color: #8a95a5; }
        .contact-us a { color: #3b82f6; text-decoration: none; font-weight: 600; }
        .footer { text-align: center; margin-top: 15px; font-size: 12px; color: #8a95a5; display: flex; justify-content: space-between; align-items: center; padding: 0 5px;}
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
        <form method="POST" action="/" id="payForm">
            <p style="font-size: 13px; color: #8a95a5; margin-bottom: 10px; font-weight: 500; text-transform: uppercase;">Select Premium Plan</p>
            <div class="plan-selector">${plansHtml}</div>
            <div class="divider"></div>
            <button type="submit" name="pay_now" class="pay-btn" id="payBtn">
                <i class="fas fa-qrcode"></i> Proceed to Pay & Get Key
            </button>
        </form>
        <div class="contact-us">
            Any issue? Contact <a href="https://t.me/SellerOfKing" target="_blank"><i class="fab fa-telegram"></i> @SellerOfKing</a>
        </div>
        <div class="footer"><div class="secure"><i class="fas fa-lock"></i> 100% Secure</div><div>Powered by Trust</div></div>
    </div>
    <script>
        document.querySelectorAll('.plan-option').forEach(option => {
            option.addEventListener('click', function() {
                document.querySelectorAll('.plan-option').forEach(opt => opt.classList.remove('selected'));
                this.classList.add('selected');
                this.querySelector('input[type="radio"]').checked = true;
            });
        });
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
    let jsAlerts = '';

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
            <div class="status-box" style="color: #ef4444; border-color: rgba(239, 68, 68, 0.3);"><i class="fas fa-times-circle"></i> Database Error Occurred</div>
        `;
    } else {
        dynamicContent = `
            <div class="status-box" style="color: #10b981; border-color: rgba(16, 185, 129, 0.3);"><i class="fas fa-check-circle"></i> Key Generated Successfully</div>
            <div class="alert-box">⚠️ <strong>Important:</strong> Please save this premium key in a safe place (Notes/WhatsApp) for future use.<br><br>For any issues, contact <strong>@SellerOfKing</strong> on Telegram.</div>
            <div class="key-container"><div class="key-text" id="myKey">${cardKey}</div></div>
            <button class="btn-action" id="copyBtn" onclick="copyKey()"><i class="fas fa-copy"></i> Copy & Paste On Your App</button>
        `;
        jsAlerts = `
        window.onload = function() { setTimeout(function() { alert("✅ KEY GENERATED SUCCESSFULLY!\\n\\n⚠️ IMPORTANT: Please copy and save your premium key somewhere safe for future use.\\n\\n📞 Any issue? Contact on Telegram: @SellerOfKing"); }, 500); };
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
        .status-box { background: #131722; border: 1px solid #232a3b; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 10px; font-size: 14px; margin-bottom: 20px; }
        .alert-box { background: rgba(234, 179, 8, 0.1); border: 1px solid rgba(234, 179, 8, 0.3); color: #eab308; padding: 12px; border-radius: 8px; font-size: 13px; text-align: center; margin-bottom: 15px; line-height: 1.5;}
        .key-container { background: #0f1319; border: 1px dashed #3b82f6; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 20px; }
        .key-text { font-size: 18px; font-weight: 700; color: #fff; letter-spacing: 2px; word-break: break-all; }
        .btn-action { background-color: #3b82f6; color: #fff; border: none; padding: 15px; font-size: 15px; font-weight: 600; border-radius: 10px; width: 100%; cursor: pointer; transition: 0.2s ease; display: flex; justify-content: center; align-items: center; gap: 8px; }
        .btn-action:active { transform: scale(0.98); }
        .btn-refresh { background-color: #232a3b; color: #fff; margin-top: 10px; }
        .contact-us { text-align: center; margin-top: 25px; font-size: 13px; color: #8a95a5; }
        .contact-us a { color: #3b82f6; text-decoration: none; font-weight: 600; }
        .footer { text-align: center; margin-top: 15px; font-size: 12px; color: #8a95a5; display: flex; justify-content: space-between; align-items: center; padding: 0 5px;}
        .footer .secure { color: #10b981; display: flex; align-items: center; gap: 5px; }
    </style>
</head>
<body>
    <div class="payment-card">
        <div class="header">
            <div class="brand"><div class="brand-icon"><i class="fas fa-check" style="color: #10b981; font-size: 20px;"></i></div><div class="brand-text"><h3>Trust</h3><p>Payment Success</p></div></div>
            <div class="tag">#${orderShort}</div>
        </div>
        <div class="divider"></div>
        ${dynamicContent}
        <div class="contact-us">Any issue? Contact <a href="https://t.me/SellerOfKing" target="_blank"><i class="fab fa-telegram"></i> @SellerOfKing</a></div>
        <div class="footer"><div class="secure"><i class="fas fa-lock"></i> 100% Secure</div><div>Powered by Trust</div></div>
    </div>
    <script>
        ${jsAlerts}
        function copyKey() {
            var keyText = document.getElementById("myKey").innerText;
            navigator.clipboard.writeText(keyText).then(function() {
                var btn = document.getElementById('copyBtn');
                btn.innerHTML = '<i class="fas fa-check-double"></i> Copied to Clipboard!';
                btn.style.backgroundColor = '#10b981';
                alert("✅ Key Copied!\\n\\nPlease save it securely. If you face any issues, message @SellerOfKing on Telegram.");
                setTimeout(function() { btn.innerHTML = '<i class="fas fa-copy"></i> Copy & Paste On Your App'; btn.style.backgroundColor = '#3b82f6'; }, 2000);
            }).catch(function(err) { alert("Failed to copy. Please select the text and copy manually."); });
        }
    </script>
</body>
</html>`;
}

module.exports = app;

