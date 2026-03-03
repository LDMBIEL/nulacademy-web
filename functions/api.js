const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Limit besar untuk upload

app.use((req, res, next) => {
  if (req.path.startsWith('/.netlify/functions/api')) {
    req.url = req.path.replace('/.netlify/functions/api', '') || '/';
  }
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'secret_rahasia';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper: Generate ID Unik
const generateUID = () => {
  return 'NU-' + Math.random().toString(36).substring(2, 6).toUpperCase();
};

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

// ================= ROUTES =================

// 1. Login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('akun').select('*').eq('email', email).single();

    if (error || !user) return res.status(401).json({ error: 'Email tidak ditemukan' });
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Password salah!' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    const userRes = { ...user };
    delete userRes.password;
    res.json({ token, user: userRes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Register (Student Only, Generate Unique ID)
app.post('/register', async (req, res) => {
  try {
    const { nama, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email & password wajib' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const kodeUnik = generateUID();

    const { data, error } = await supabase.from('akun').insert([{
      kode_unik: kodeUnik,
      nama, 
      email, 
      password: hashedPassword, 
      role: 'student', // Force Student
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

// 3. Get Courses
app.get('/courses', authMiddleware, async (req, res) => {
  const { data: courses, error } = await supabase.from('course').select('*').order('urutan', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });

  const paket = req.user.paket_aktif;
  let limit = 0;
  if (paket === 'Bisa Excel') limit = 4;
  else if (paket === 'Jago Excel') limit = 8;
  else if (paket === 'Ahli Excel') limit = 12;
  
  if (req.user.role === 'teacher') limit = 12;

  const result = courses.map((c, index) => ({ ...c, isLocked: (index + 1) > limit }));
  res.json(result);
});

// 4. Get Single Course Detail
app.get('/course/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('course').select('*').eq('id', id).single();
  if (error) return res.status(400).json({ error: error.message });

  // Cek apakah user sudah upload tugas untuk ini
  const { data: tugas } = await supabase.from('tugas')
    .select('*')
    .eq('course_id', id)
    .eq('user_id', req.user.id)
    .single();

  res.json({ course: data, myTugas: tugas || null });
});

// 5. Upload Tugas
app.post('/upload-tugas', authMiddleware, async (req, res) => {
  const { courseId, fileName, fileData } = req.body;
  const filePath = `tugas/${req.user.id}/${courseId}_${fileName}`;
  const buffer = Buffer.from(fileData, 'base64');
  
  const { error: uploadError } = await supabase.storage.from('tugas').upload(filePath, buffer, { upsert: true });
  if (uploadError) return res.status(400).json({ error: 'Gagal upload file' });

  const { data: urlData } = supabase.storage.from('tugas').getPublicUrl(filePath);
  
  // Upsert tugas (kalau sudah ada update, kalau belum insert)
  const { error: dbError } = await supabase.from('tugas').upsert([{
    user_id: req.user.id,
    course_id: courseId,
    file_url: urlData.publicUrl,
    status: 'submitted',
    nilai: null, // Reset nilai jika diupload ulang
    komentar: null
  }], { onConflict: 'user_id, course_id' }); // Pastikan ada constraint unique user_id, course_id di DB jika pakai upsert ini, atau manual logic
  // Untuk simplisitas, kita insert baru saja. Teacher bisa lihat history.
  
  // Simplified Insert:
  await supabase.from('tugas').insert([{
    user_id: req.user.id,
    course_id: courseId,
    file_url: urlData.publicUrl,
    status: 'submitted'
  }]);

  res.status(201).json({ message: 'Tugas terkirim!' });
});

// 6. Teacher: Get All Submissions
app.get('/submissions', authMiddleware, async (req, res) => {
  if(req.user.role !== 'teacher') return res.status(403).json({error: 'Forbidden'});
  const { data } = await supabase.from('tugas')
    .select('*, course(judul_course), akun(nama, kode_unik)')
    .order('submitted_at', { ascending: false });
  res.json(data);
});

// 7. Teacher: Give Grade
app.post('/grade', authMiddleware, async (req, res) => {
  if(req.user.role !== 'teacher') return res.status(403).json({error: 'Forbidden'});
  const { tugasId, nilai, komentar } = req.body;
  const { error } = await supabase.from('tugas')
    .update({ nilai: nilai, komentar: komentar, status: 'graded' })
    .eq('id', tugasId);
  
  if(error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Nilai tersimpan' });
});

// ================= SOSIAL FITUR =================

// 8. Search Friend by ID
app.get('/search-friend', authMiddleware, async (req, res) => {
  const { kode } = req.query;
  const { data, error } = await supabase.from('akun').select('id, nama, kode_unik').eq('kode_unik', kode).single();
  if (error || !data) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (data.id === req.user.id) return res.status(400).json({ error: 'Tidak bisa mencari diri sendiri' });
  res.json(data);
});

// 9. Add Friend (Limit 10)
app.post('/add-friend', authMiddleware, async (req, res) => {
  const { friendId } = req.body;
  
  // Cek jumlah teman
  const { count, error: countError } = await supabase.from('teman')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user.id);
  
  if (count >= 10) return res.status(400).json({ error: 'Batas maksimal 10 teman tercapai' });

  // Insert Friendship (A ke B dan B ke A)
  await supabase.from('teman').insert([
    { user_id: req.user.id, teman_id: friendId },
    { user_id: friendId, teman_id: req.user.id }
  ]);

  res.json({ message: 'Teman ditambahkan' });
});

// 10. Get My Friends
app.get('/friends', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('teman')
    .select('teman_id, akun(id, nama, kode_unik)') // Join ke tabel akun
    .eq('user_id', req.user.id);
  
  // Cleanup data structure
  const friends = data.map(d => d.akun);
  res.json(friends);
});

// 11. Get Private Chat History
app.get('/chat-pribadi/:friendId', authMiddleware, async (req, res) => {
  const { friendId } = req.params;
  const myId = req.user.id;

  // Ambil chat where (pengirim=aku & penerima=dia) OR (pengirim=dia & penerima=aku)
  const { data } = await supabase.from('chat_pribadi')
    .select('*')
    .or(`and(pengirim_id.eq.${myId},penerima_id.eq.${friendId}),and(pengirim_id.eq.${friendId},penerima_id.eq.${myId})`)
    .order('created_at', { ascending: true });

  res.json(data);
});

// 12. Send Private Chat
app.post('/chat-pribadi', authMiddleware, async (req, res) => {
  const { penerima_id, pesan } = req.body;
  const { error } = await supabase.from('chat_pribadi').insert([{
    pengirim_id: req.user.id,
    penerima_id: penerima_id,
    pesan: pesan
  }]);
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Terkirim' });
});

// 13. Chat Room (Group)
app.get('/chat-room', authMiddleware, async (req, res) => {
  let kelas = req.user.paket_aktif;
  if (req.user.role === 'teacher') kelas = req.query.kelas; // Teacher pilih kelas

  const { data } = await supabase.from('chat')
    .select('*, akun(nama, kode_unik)')
    .eq('kelas', kelas)
    .order('created_at', { ascending: true });
  res.json(data);
});

app.post('/chat-room', authMiddleware, async (req, res) => {
  const { pesan, kelas } = req.body;
  const targetKelas = req.user.role === 'teacher' ? kelas : req.user.paket_aktif;
  
  const { error } = await supabase.from('chat').insert([{
    user_id: req.user.id, kelas: targetKelas, pesan
  }]);
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Terkirim' });
});

// 14. Admin: Get Students & Update Paket
app.get('/admin/students', authMiddleware, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
  const { data } = await supabase.from('akun').select('*').eq('role', 'student');
  res.json(data);
});

app.post('/admin/update-paket', authMiddleware, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
  const { userId, paket } = req.body;
  await supabase.from('akun').update({ paket_aktif: paket }).eq('id', userId);
  res.json({ message: 'Updated' });
});

exports.handler = serverless(app);
