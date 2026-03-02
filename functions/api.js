const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Limit besar untuk upload file

// Perbaikan Path
app.use((req, res, next) => {
  if (req.path.startsWith('/.netlify/functions/api')) {
    req.url = req.path.replace('/.netlify/functions/api', '') || '/';
  }
  next();
});

// Config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'secret_rahasia';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Middleware Auth
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

// ROUTES

// 1. Login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('akun').select('*').eq('email', email).single();

    if (error || !user) {
      return res.status(401).json({ error: 'Email tidak ditemukan. Coba Daftar jika belum punya akun.' });
    }
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Password salah!' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    const userRes = { ...user };
    delete userRes.password;
    res.json({ token, user: userRes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Register (Hanya Student)
app.post('/register', async (req, res) => {
  try {
    const { nama, email, password, kelas } = req.body;
    
    // Validasi input
    if (!email || !password) return res.status(400).json({ error: 'Email & password wajib' });

    // Cek email teacher
    if (email === 'baguslathifazya@gmail.com') {
       return res.status(403).json({ error: 'Akun ini sudah terdaftar sebagai Teacher. Silakan Login.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert dengan role student default
    const { data, error } = await supabase.from('akun').insert([{
      nama, 
      email, 
      password: hashedPassword, 
      role: 'student', // Paksa Student
      kelas: kelas || 'Pemula',
      paket_aktif: 'Belum Ada' 
    }]).select();

    if (error) {
       if(error.code === '23505') return res.status(400).json({ error: 'Email sudah terdaftar.' });
       throw error;
    }
    res.status(201).json({ message: 'Registrasi Sukses', user: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Profile
app.get('/profile', authMiddleware, (req, res) => {
  res.json(req.user);
});

// 4. Courses (Logic Paket)
app.get('/courses', authMiddleware, async (req, res) => {
  const { data: courses, error } = await supabase.from('course').select('*').order('urutan', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });

  // Logika Akses Paket
  const paket = req.user.paket_aktif;
  let limit = 0;

  if (paket === 'Bisa Excel') limit = 4;
  else if (paket === 'Jago Excel') limit = 8;
  else if (paket === 'Ahli Excel') limit = 12;
  else limit = 0; // Jika belum ada paket

  // Jika Teacher, buka semua
  if (req.user.role === 'teacher') limit = 12;

  // Tandai course terkunci
  const result = courses.map((c, index) => ({
    ...c,
    isLocked: (index + 1) > limit
  }));

  res.json(result);
});

// 5. Upload Tugas (Student)
app.post('/upload-tugas', authMiddleware, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Hanya student' });
  
  const { courseId, fileName, fileData } = req.body; // fileData adalah base64 string

  // 1. Upload ke Supabase Storage
  const filePath = `tugas/${req.user.id}/${courseId}_${fileName}`;
  const buffer = Buffer.from(fileData, 'base64');
  
  const { error: uploadError } = await supabase.storage
    .from('tugas') // nama bucket
    .upload(filePath, buffer, { upsert: true });

  if (uploadError) return res.status(400).json({ error: 'Gagal upload file' });

  // 2. Dapatkan Public URL
  const { data: urlData } = supabase.storage.from('tugas').getPublicUrl(filePath);
  const fileUrl = urlData.publicUrl;

  // 3. Simpan ke tabel tugas
  const { data, error: dbError } = await supabase.from('tugas').insert([{
    user_id: req.user.id,
    course_id: courseId,
    file_url: fileUrl,
    status: 'pending'
  }]).select();

  if (dbError) return res.status(400).json({ error: dbError.message });
  res.status(201).json({ message: 'Tugas terkirim!', data });
});

// 6. Get Tugas (Untuk Dashboard Student & Teacher)
app.get('/tugas', authMiddleware, async (req, res) => {
  let query = supabase.from('tugas').select('*, course(judul_course), akun(nama)');
  
  // Jika teacher, ambil semua. Jika student, ambil miliknya saja.
  if (req.user.role === 'student') {
    query = query.eq('user_id', req.user.id);
  }
  
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// 7. Chat (Logic Paket)
app.get('/chat', authMiddleware, async (req, res) => {
  let kelas = req.query.kelas;
  
  // Teacher bisa akses semua room
  if (req.user.role === 'teacher') {
     if(!kelas) return res.json([]); // harus pilih room
     // gunakan parameter kelas
  } else {
     // Student hanya bisa akses chat sesuai paketnya
     kelas = req.user.paket_aktif; 
  }

  const { data } = await supabase.from('chat')
    .select('id, pesan, created_at, akun(nama)')
    .eq('kelas', kelas)
    .order('created_at', { ascending: true });
  res.json(data);
});

app.post('/chat', authMiddleware, async (req, res) => {
  const { pesan } = req.body;
  let kelas = req.user.paket_aktif;
  
  // Teacher pilih kelas mana? Untuk simplisitas, teacher kirim ke room yang dia buka
  // Atau di frontend kirim parameter 'kelas' manual
  if(req.user.role === 'teacher') {
      kelas = req.body.kelas || 'Bisa Excel'; // Default
  }

  const { data, error } = await supabase.from('chat').insert([{
    user_id: req.user.id, kelas: kelas, pesan
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// 8. Admin: Get All Users (Teacher Only)
app.get('/users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
  const { data } = await supabase.from('akun').select('*');
  res.json(data);
});

// 9. Admin: Update User (Teacher Only)
app.post('/update-user', authMiddleware, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
  const { userId, updateData } = req.body; // updateData berisi { paket_aktif, kelas, dll }
  
  const { data, error } = await supabase.from('akun').update(updateData).eq('id', userId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'User updated', data });
});

exports.handler = serverless(app);
