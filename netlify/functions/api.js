const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// KONFIGURASI (Netlify akan mengisi ini nanti)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'rahasia';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- MIDDLEWARE AUTH ---
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token diperlukan' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data } = await supabase.from('akun').select('*').eq('id', decoded.userId).single();
    if (!data) return res.status(401).json({ error: 'User tidak valid' });
    req.user = data;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid' });
  }
};

// --- ROUTES ---

// 1. Register
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

// 2. Login
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

// 3. Courses
app.get('/courses', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('course').select('*');
  res.json(data);
});

app.post('/courses', authMiddleware, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Hanya teacher' });
  const { judul, deskripsi, link } = req.body;
  const { data, error } = await supabase.from('course').insert([{
    judul_course: judul, deskripsi, link_drive: link, user_id: req.user.id
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// 4. Chat
app.get('/chat', authMiddleware, async (req, res) => {
  let kelas = req.query.kelas;
  if (req.user.role === 'student') kelas = req.user.kelas;
  const { data } = await supabase.from('chat').select('id, pesan, created_at, akun(nama)').eq('kelas', kelas).order('created_at', { ascending: true });
  res.json(data);
});

app.post('/chat', authMiddleware, async (req, res) => {
  const { pesan } = req.body;
  const { data, error } = await supabase.from('chat').insert([{
    user_id: req.user.id, kelas: req.user.kelas, pesan
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

exports.handler = serverless(app);