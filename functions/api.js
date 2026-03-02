const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// INI DIA SOLUSINYA: Middleware untuk perbaiki path
app.use((req, res, next) => {
  if (req.path.startsWith('/.netlify/functions/api')) {
    req.url = req.path.replace('/.netlify/functions/api', '') || '/';
  }
  next();
});

// KONFIGURASI
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'rahasia';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ROUTE TEST (Untuk memastikan hidup)
app.get('/test', (req, res) => {
  res.json({ status: "Backend OK!", db_url: SUPABASE_URL ? "Ada" : "Kosong" });
});

// AUTH: REGISTER
app.post('/register', async (req, res) => {
  try {
    const { nama, email, password, role, kelas } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email & password wajib' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('akun').insert([{
      nama, email, password: hashedPassword, role: role || 'student', kelas
    }]).select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ message: 'Sukses', user: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AUTH: LOGIN
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('akun').select('*').eq('email', email).single();

    if (error || !user) return res.status(401).json({ error: 'Email salah' });
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Password salah' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    const userRes = { ...user };
    delete userRes.password;
    res.json({ token, user: userRes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTES LAINNYA (Courses, Chat) bisa ditaruh di bawah ini...
// (Salin route courses dan chat dari kode sebelumnya jika perlu)

exports.handler = serverless(app);
