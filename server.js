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
        
        // Security Check: Only allow amounts defined in Env
        if (!PLAN_RATES.hasOwnProperty(selectedAmount)) {
            return res.send(renderIndexHtml("Please select a valid plan."));
        }

        // Generate a unique Order ID for the new gateway
        const orderId = 'ORD_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex').toUpperCase();

        const payload = {
            amount: selectedAmount.toString(),
            order_id: orderId,
            customer_name: "Premium User", 
            description: `Key for ${PLAN_RATES[selectedAmount]} Days`,
            callback_url: process.env.SUCCESS_URL
        };

        // Create Order via New Gateway API
        const response = await fetch('https://payment.techbloggers.in/api/create-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': process.env.API_KEY,
                'X-API-Secret': process.env.API_SECRET
            },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();

        // Successful link generation validation
        if (data.status === 'success' && data.data && data.data.payment_url) {
            // Save details in cookies for verification later
            res.cookie('my_order_id', orderId, { maxAge: 900000, httpOnly: true });
            res.cookie('my_order_amount', selectedAmount, { maxAge: 900000, httpOnly: true });
            
            // Redirect customer to the checkout page
            res.redirect(data.data.payment_url);
        } else {
            console.error("Create Order Error:", data);
            res.send(renderIndexHtml("Payment gateway error: " + (data.message || data.error || "Please try again.")));
        }
    } catch (error) {
        console.error("Connection Error:", error);
        res.send(renderIndexHtml("Unable to connect to the server. Gateway might be down."));
    }
});

// ==========================================
// KEY GENERATION LOCK (Database Level Atomic Insert)
// ==========================================
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
            console.log(`SUCCESS 💰: Key generated. Plan: ${duration} Days | Key: ${newCard} | Order: ${orderId}`);
        } else {
            console.log(`SKIPPED ⏩: OrderID ${orderId} already exists in database. Duplicate prevented.`);
        }
    } catch (error) {
        console.error("DB ERROR ❌:", error.message);
    }
}

// ==========================================
// 3. SUCCESS / CALLBACK PAGE
// ==========================================
app.get('/success', async (req, res) => {
    // Gateway order_id query me return kar sakta hai, varna cookie se uthayenge
    let orderId = req.query.order_id || req.cookies.my_order_id || '';

    if (!orderId) {
        return res.send("<div style='background:#0f1319; color:#fff; text-align:center; padding:50px; font-family:sans-serif; height:100vh;'><h2>❌ Invalid Access or Session Expired</h2></div>");
    }

    if (!req.cookies.my_order_id) {
        res.cookie('my_order_id', orderId, { maxAge: 900000, httpOnly: true });
    }

    const markNote = `OrderID: ${orderId}`;
    const amount = parseFloat(req.cookies.my_order_amount || 0);
    
    let duration = 0;
    if (PLAN_RATES.hasOwnProperty(amount)) {
        duration = PLAN_RATES[amount];
    }

    let verified = false;

    // Verify actual payment status via backend-to-backend API check
    if (orderId && duration > 0) {
        try {
            const checkRes = await fetch('https://payment.techbloggers.in/api/check-status', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': process.env.API_KEY,
                    'X-API-Secret': process.env.API_SECRET
                },
                body: JSON.stringify({ order_id: orderId })
            });
            
            const checkData = await checkRes.json();
            
            if (checkData.status === 'success' && checkData.data) {
                const txnStatus = (checkData.data.status || checkData.data.payment_status || '').toUpperCase();
                
                // Assuming 'SUCCESS', 'PAID', or 'COMPLETED' means payment is done
                if (txnStatus === 'SUCCESS' || txnStatus === 'PAID' || txnStatus === 'COMPLETED') {
                    verified = true;
                }
            }
        } catch (e) {
            console.error("Gateway verification failed:", e.message);
        }
    }

    // Agar payment verify ho gayi hai tabhi key generate karein
    if (verified && duration > 0) {
        await generateKeyIfNeeded(orderId, duration);
    }

    let cardKey = "WAITING / UNPAID";
    try {
        const [rows] = await db.execute(
            "SELECT card FROM single_card WHERE mark = ? ORDER BY id DESC LIMIT 1",
            [markNote]
        );

        if (rows.length > 0) {
            cardKey = rows[0].card;
        }
    } catch (error) {
        cardKey = "DB ERROR";
    }

    // Success HTML render (calling existing or provided function below)
    res.send(renderSuccessHtml(orderId, cardKey, verified));
});

// ==========================================
// EXACT HTML/CSS UI TEMPLATES
// ==========================================
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

// Added this function in case you didn't have it explicitly defined in the file
function renderSuccessHtml(orderId, cardKey, isVerified) {
    let statusText = isVerified ? "Payment Successful" : "Payment Pending / Failed";
    let statusColor = isVerified ? "#10b981" : "#ef4444";
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Transaction Status</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        body { font-family: -apple-system, sans-serif; background-color: #0f1319; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #181d29; padding: 30px; border-radius: 16px; text-align: center; max-width: 400px; width: 90%; border: 1px solid #232a3b; }
        .key-box { background: #131722; padding: 15px; border-radius: 8px; margin: 20px 0; font-family: monospace; font-size: 18px; color: #3b82f6; word-break: break-all; }
    </style>
</head>
<body>
    <div class="card">
        <h2 style="color: ${statusColor};">${statusText}</h2>
        <p style="color: #8a95a5; margin-top: 10px;">Order ID: ${orderId}</p>
        
        <div style="margin-top: 25px;">
            <p style="font-size: 14px;">Your Premium Key:</p>
            <div class="key-box">${cardKey}</div>
            ${isVerified ? '<p style="font-size: 12px; color: #10b981;">Please copy and save your key.</p>' : '<p style="font-size: 12px; color: #ef4444;">Complete the payment or wait a moment for confirmation.</p>'}
        </div>
        
        <button onclick="window.location.href='/'" style="margin-top: 20px; background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer;">Go Home</button>
    </div>
</body>
</html>`;
}

module.exports = app;
