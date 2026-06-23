const express = require('express');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(cookieParser());

app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: true }));

let PLAN_RATES = {};
try {
    PLAN_RATES = JSON.parse(process.env.PLAN_RATES || '{"50":1,"300":15,"500":30}');
} catch (e) {
    console.error("PLAN_RATES environment variable is not valid JSON.");
}

const PAYINDIA_API_KEY = process.env.API_KEY;
const PAYINDIA_API_SECRET = process.env.API_SECRET;
const PAYINDIA_BASE = 'https://payment.techbloggers.in/api';

app.get('/', (req, res) => {
    res.send(renderIndexHtml());
});

app.post('/', async (req, res) => {
    try {
        const selectedAmount = req.body.amount;

        if (!PLAN_RATES.hasOwnProperty(selectedAmount)) {
            return res.send(renderIndexHtml("Please select a valid plan."));
        }

        const orderId = 'ORD_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5).toUpperCase();

        const payload = {
            amount: parseFloat(selectedAmount).toFixed(2),
            order_id: orderId,
            customer_name: 'Customer',
            callback_url: req.protocol + '://' + req.get('host') + '/success?order_id=' + orderId
        };

        const response = await fetch(PAYINDIA_BASE + '/create-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': PAYINDIA_API_KEY,
                'X-API-Secret': PAYINDIA_API_SECRET
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.status === 'success' && data.data.payment_url) {
            res.cookie('my_order_id', orderId, { maxAge: 900000, httpOnly: true });
            res.cookie('my_order_amount', selectedAmount, { maxAge: 900000, httpOnly: true });
            res.redirect(data.data.payment_url);
        } else {
            res.send(renderIndexHtml("Payment link generation failed. Please try again."));
        }
    } catch (error) {
        console.error("PayIndia error:", error);
        res.send(renderIndexHtml("Unable to connect to payment gateway."));
    }
});

async function generateKeyIfNeeded(orderId, duration) {
    const markNote = `OrderID: ${orderId}`;

    try {
        const newCard = crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');

        const insertQuery = `
            INSERT INTO single_card (card, value, type, mark, usable, soft_id)
            SELECT ?, ?, 3, ?, 1, ?
            FROM DUAL
            WHERE NOT EXISTS (
                SELECT 1 FROM single_card WHERE mark = ?
            )
        `;

        const [result] = await db.execute(insertQuery, [
            newCard,
            duration,
            markNote,
            process.env.SOFT_ID,
            markNote
        ]);

        if (result.affectedRows > 0) {
            console.log(`SUCCESS: Key generated. Plan: ${duration} Days | Key: ${newCard} | Order: ${orderId}`);
        } else {
            console.log(`SKIPPED: OrderID ${orderId} already exists. Duplicate prevented.`);
        }
    } catch (error) {
        console.error("DB ERROR:", error.message);
    }
}

app.get('/success', async (req, res) => {
    let orderId = req.cookies.my_order_id || req.query.order_id || '';
    const isPaymentSuccess = req.query.status === 'success';

    if (!orderId) {
        return res.send("<div style='background:#0f1319; color:#fff; text-align:center; padding:50px; font-family:sans-serif; height:100vh;'><h2>Invalid Access</h2></div>");
    }

    if (!req.cookies.my_order_id) {
        res.cookie('my_order_id', orderId, { maxAge: 900000, httpOnly: true });
    }

    const markNote = `OrderID: ${orderId}`;

    if (isPaymentSuccess) {
        let verified = false;
        try {
            const checkRes = await fetch(PAYINDIA_BASE + '/check-status', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': PAYINDIA_API_KEY,
                    'X-API-Secret': PAYINDIA_API_SECRET
                },
                body: JSON.stringify({ order_id: orderId })
            });
            const checkData = await checkRes.json();
            if (checkData.status === 'success' && checkData.data.payment_status === 'success') {
                verified = true;
            }
        } catch (e) {
            console.error("PayIndia verification failed:", e.message);
        }

        if (verified) {
            const amount = parseFloat(req.cookies.my_order_amount || 0);
            let duration = 0;
            if (PLAN_RATES.hasOwnProperty(amount)) {
                duration = PLAN_RATES[amount];
            }
            if (duration > 0) {
                await generateKeyIfNeeded(orderId, duration);
            }
        }
    }

    let cardKey = "WAITING";
    try {
        const [rows] = await db.execute(
            "SELECT card FROM single_card WHERE mark = ? ORDER BY id DESC LIMIT 1",
            [markNote]
        );

        if (rows.length > 0) {
            cardKey = rows[0].card;
        }
    } catch (error) {
        cardKey = "ERROR";
    }

    res.send(renderSuccessHtml(orderId, cardKey));
});

function renderIndexHtml(errorMsg = null) {
    let errorHtml = errorMsg ? `<div class="error-msg"><i class="fas fa-exclamation-triangle"></i> ${errorMsg}</div>` : '';
    let plansHtml = '';
    let isFirst = true;

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

    let introDisplay = errorMsg ? 'none' : 'flex';
    let formDisplay = errorMsg ? 'block' : 'none';

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

        .intro-section { display: ${introDisplay}; flex-direction: column; gap: 15px; margin-bottom: 10px; }
        .animated-title { text-align: center; font-size: 15px; font-weight: 600; color: #10b981; animation: pulse 2s infinite; display: flex; justify-content: center; align-items: center; gap: 8px; }
        @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.02); } 100% { opacity: 1; transform: scale(1); } }
        .video-wrapper { position: relative; padding-bottom: 56.25%; height: 0; border-radius: 12px; overflow: hidden; border: 1px solid #232a3b; background: #000; }
        .video-wrapper iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
        .proceed-to-plans-btn { background-color: #3b82f6; color: #fff; border: none; padding: 15px; font-size: 15px; font-weight: 600; border-radius: 12px; width: 100%; cursor: pointer; transition: 0.2s ease; display: flex; justify-content: center; align-items: center; gap: 8px; margin-top: 5px; }
        .proceed-to-plans-btn:active { transform: scale(0.98); }

        #payForm { display: ${formDisplay}; }
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

        <div id="introSection" class="intro-section">
            <div class="animated-title">
                <i class="fas fa-play-circle"></i> How to purchase key
            </div>
            <div class="video-wrapper">
                <iframe src="https://player.vimeo.com/video/1203472119" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
            </div>
            <button type="button" class="proceed-to-plans-btn" id="showPlansBtn">
                Proceed to Purchase Key <i class="fas fa-arrow-right"></i>
            </button>
        </div>

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
        document.getElementById('showPlansBtn')?.addEventListener('click', function() {
            document.getElementById('introSection').style.display = 'none';
            document.getElementById('payForm').style.display = 'block';
        });

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
