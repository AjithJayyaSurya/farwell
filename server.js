require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express    = require('express');
const mongoose   = require('mongoose');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cors       = require('cors');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Cloudinary config ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

const studentSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  studentId:   { type: String, required: true, trim: true, unique: true },
  photoUrl:    { type: String, required: true },
  publicId:    { type: String },          // Cloudinary public_id for deletion
  submittedAt: { type: Date, default: Date.now }
});

const Student = mongoose.model('Student', studentSchema);

// ── Multer → Cloudinary storage ──────────────────────────────────────────────
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:         'farwell-students',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
    transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }]
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'form.html')));

app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Submit
app.post('/api/submit', upload.single('photo'), async (req, res) => {
  try {
    const { name, studentId } = req.body;

    if (!name || !studentId) {
      if (req.file) await cloudinary.uploader.destroy(req.file.filename);
      return res.status(400).json({ error: 'Name and Student ID are required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Photo is required' });
    }

    const existing = await Student.findOne({
      studentId: { $regex: new RegExp(`^${studentId.trim()}$`, 'i') }
    });

    if (existing) {
      await cloudinary.uploader.destroy(req.file.filename);
      return res.status(409).json({ error: `Student ID "${studentId}" has already submitted a photo` });
    }

    const student = new Student({
      name:      name.trim(),
      studentId: studentId.trim(),
      photoUrl:  req.file.path,
      publicId:  req.file.filename
    });

    await student.save();
    console.log(`✅ Saved: ${student.name} (${student.studentId})`);
    res.json({ success: true, message: 'Photo submitted successfully!' });

  } catch (err) {
    if (err.code === 11000) {
      if (req.file) await cloudinary.uploader.destroy(req.file.filename);
      return res.status(409).json({ error: 'This Student ID has already submitted' });
    }
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Get all students
app.get('/api/students', async (req, res) => {
  try {
    const students = await Student.find()
      .select('name studentId photoUrl submittedAt')
      .sort({ submittedAt: -1 });
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Delete student
app.delete('/api/students/:id', async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (student) {
      if (student.publicId) {
        await cloudinary.uploader.destroy(student.publicId);
      }
      await Student.findByIdAndDelete(req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// Export CSV
app.get('/api/export/csv', async (req, res) => {
  try {
    const students = await Student.find().sort({ submittedAt: 1 });
    let csv = 'Name,Student ID,Photo URL,Submitted At\n';
    students.forEach(s => {
      csv += `"${s.name}","${s.studentId}","${s.photoUrl}","${new Date(s.submittedAt).toLocaleString()}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="students_${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File size exceeds 50MB limit' });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server  : http://localhost:${PORT}`);
  console.log(`📋 Form    : http://localhost:${PORT}/`);
  console.log(`🛠️  Admin   : http://localhost:${PORT}/admin\n`);
});
