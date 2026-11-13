const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const app = express();
const PORT = 3000;
const JWT_SECRET = "super_secret_key_123";

app.use(cors());
app.use(express.json({ limit: '10mb' })); 
app.use(express.static('public'));

// --- DATABASE CONNECTION ---
const DB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/usdt_exchange';
mongoose.connect(DB_URI)
    .then(() => console.log("MongoDB Connected Successfully"))
    .catch(err => console.log("MongoDB Error: ", err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    inrBalance: { type: Number, default: 5000 }, 
    usdtBalance: { type: Number, default: 50 }
});
const User = mongoose.model('User', userSchema);

const tradeSchema = new mongoose.Schema({
    username: String,
    type: String,
    amount: Number,
    rate: Number,
    totalINR: Number,
    date: { type: Date, default: Date.now }
});
const Trade = mongoose.model('Trade', tradeSchema);

const settingSchema = new mongoose.Schema({
    upiId: { type: String, default: 'demo@upi' },
    qrImage: { type: String, default: '' }
});
const Setting = mongoose.model('Setting', settingSchema);

// --- API ROUTES ---

// 1. Live Rate API
app.get('/api/rate', async (req, res) => {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr');
        res.json({ success: true, rate: response.data.tether.inr });
    } catch (error) {
        res.json({ success: false, rate: 85.50 });
    }
});

// 2. Register API
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.json({ success: false, message: "Username already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.json({ success: true, message: "Registration successful!" });
    } catch (error) {
        res.json({ success: false, message: "Server error" });
    }
});

// 3. Login API
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false, message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.json({ success: false, message: "Invalid password" });

        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ success: true, token, user: { username: user.username, inrBalance: user.inrBalance, usdtBalance: user.usdtBalance } });
    } catch (error) {
        res.json({ success: false, message: "Server error" });
    }
});

// 4. QR Code Generation (Auto Amount)
app.post('/api/generate-qr', async (req, res) => {
    try {
        const { amount, upiId } = req.body;
        if (!amount) return res.json({ success: false, message: "Amount required" });

        const rateRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr');
        const currentRate = rateRes.data.tether.inr || 85.50;
        const inrAmount = (amount * currentRate).toFixed(2); 

        const upiString = `upi://pay?pa=${upiId || 'demo@upi'}&pn=USDT%20Exchange&am=${inrAmount}&cu=INR`;
        const qrDataUrl = await QRCode.toDataURL(upiString, { color: { dark: '#000000', light: '#ffffff' }, width: 250 });

        res.json({ success: true, qrCode: qrDataUrl, calculatedINR: inrAmount });
    } catch (error) {
        res.json({ success: false, message: "QR Generation Failed" });
    }
});

// 5. Trade (Buy/Sell)
app.post('/api/trade', async (req, res) => {
    const { type, amount, username } = req.body;
    const tradeAmount = parseFloat(amount);

    try {
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false, message: "User not found" });

        const rateRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr');
        const currentRate = rateRes.data.tether.inr || 85.50;
        const totalINR = tradeAmount * currentRate;

        if (type === 'Buy') {
            if (user.inrBalance < totalINR) return res.json({ success: false, message: "Insufficient INR Balance" });
            user.inrBalance -= totalINR;
            user.usdtBalance += tradeAmount;
        } else {
            if (user.usdtBalance < tradeAmount) return res.json({ success: false, message: "Insufficient USDT Balance" });
            user.usdtBalance -= tradeAmount;
            user.inrBalance += totalINR;
        }

        await user.save();
        await new Trade({ username, type, amount: tradeAmount, rate: currentRate, totalINR }).save();

        res.json({ success: true, message: type + " successful!", newINR: user.inrBalance, newUSDT: user.usdtBalance });
    } catch (error) {
        res.json({ success: false, message: "Trade failed." });
    }
});

// 6. Recent Trades
app.get('/api/recent-trades', async (req, res) => {
    try {
        const trades = await Trade.find().sort({ date: -1 }).limit(5);
        res.json({ success: true, trades });
    } catch (error) { res.json({ success: false }); }
});

// 7. Admin Settings
app.get('/api/settings', async (req, res) => {
    try {
        let settings = await Setting.findOne();
        if (!settings) { settings = new Setting(); await settings.save(); }
        res.json({ success: true, settings });
    } catch (error) { res.json({ success: false }); }
});

app.post('/api/admin/settings', async (req, res) => {
    try {
        const { upiId, qrImage } = req.body;
        let settings = await Setting.findOne();
        if (upiId) settings.upiId = upiId;
        if (qrImage !== undefined) settings.qrImage = qrImage;
        await settings.save();
        res.json({ success: true, message: "Settings saved!" });
    } catch (error) { res.json({ success: false }); }
});

// 8. Admin Users List
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}, '-password');
        res.json({ success: true, users });
    } catch (error) { res.json({ success: false }); }
});
// --- DEPOSIT & WITHDRAW API ---

// Deposit
app.post('/api/deposit', async (req, res) => {
    try {
        const { username, amount } = req.body;
        const depositAmount = parseFloat(amount);
        
        if (depositAmount <= 0) return res.json({ success: false, message: "Invalid amount" });
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false, message: "User not found" });

        user.inrBalance += depositAmount;
        await user.save();

        // History mein save karein
        await new Trade({ username, type: 'Deposit', amount: depositAmount, rate: 1, totalINR: depositAmount }).save();

        res.json({ success: true, message: `₹${depositAmount} deposited successfully!`, newINR: user.inrBalance });
    } catch (error) {
        res.json({ success: false, message: "Deposit failed" });
    }
});
// Withdraw
app.post('/api/withdraw', async (req, res) => {
    try {
        const { username, amount } = req.body;
        const withdrawAmount = parseFloat(amount);
        
        if (withdrawAmount <= 0) return res.json({ success: false, message: "Invalid amount" });
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false, message: "User not found" });
        if (user.inrBalance < withdrawAmount) return res.json({ success: false, message: "Insufficient Balance" });

        user.inrBalance -= withdrawAmount;
        await user.save();

        // History mein save karein
        await new Trade({ username, type: 'Withdraw', amount: withdrawAmount, rate: 1, totalINR: withdrawAmount }).save();

        res.json({ success: true, message: `₹${withdrawAmount} withdrawn successfully!`, newINR: user.inrBalance });
    } catch (error) {
        res.json({ success: false, message: "Withdraw failed" });
    }
});
app.listen(PORT, () => {
    console.log("Server running at http://localhost:" + PORT);
});
