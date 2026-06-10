require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const cors       = require('cors');
const path       = require('path');
const { Readable } = require('stream');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Cloudinary config ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Verify Cloudinary config on startup
console.log('☁️  Cloudinary cloud_name:', process.env.CLOUDINARY_CLOUD_NAME || 'MISSING');
console.log('☁️  Cloudinary api_key:', process.env.CLOUDINARY_API_KEY ? 'SET' : 'MISSING');
console.log('☁️  Cloudinary api_secret:', process.env.CLOUDINARY_API_SECRET ? 'SET' : 'MISSING');
console.log('🗄️  MongoDB URI:', process.env.MONGODB_URI ? 'SET' : 'MISSING');

// ── MongoDB ──────────────────────────────────────────────────────────────────
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000,
      family: 4,
      bufferCommands: false
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB error:', err.message);
    console.log('🔄 Retrying in 5s...');
    setTimeout(connectDB, 5000);
  }
};
connectDB();

mongoose.connection.on('disconnected', () => {
  console.log('⚠️  MongoDB disconnected, reconnecting...');
  setTimeout(connectDB, 5000);
});

const studentSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  studentId:   { type: String, required: true, trim: true, unique: true },
  department:  { type: String, required: true, trim: true },
  photoUrl:    { type: String, required: true },
  publicId:    { type: String },
  submittedAt: { type: Date, default: Date.now }
});

const Student = mongoose.model('Student', studentSchema);

// ── Multer — memory storage ──────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

// ── Helper: upload buffer to Cloudinary ─────────────────────────────────────
function uploadToCloudinary(buffer, mimetype) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'farwell-students',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
        transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }]
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'form.html')));

// ── Admin auth middleware ────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'farwell@admin2026';

function adminAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }
  const base64 = auth.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [, password] = decoded.split(':');
  if (password !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Invalid password');
  }
  next();
}

app.get('/admin', adminAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Submit (public — students use this)
app.post('/api/submit', upload.single('photo'), async (req, res) => {
  // Check DB connection first
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database is connecting, please try again in a moment.' });
  }
  try {
    const { name, studentId, department } = req.body;

    if (!name || !studentId || !department) {
      return res.status(400).json({ error: 'Name, Student ID and Department are required' });
    }

    const validDepts = [
      'B.Tech CSE (AI & DA)',
      'B.Tech CSE (AI & ML)',
      'B.Tech CSE (CYBER)',
      'B.Tech CSE (MEDICAL)'
    ];
    if (!validDepts.includes(department)) {
      return res.status(400).json({ error: 'Invalid department selected' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Photo is required' });
    }

    const existing = await Student.findOne({
      studentId: { $regex: new RegExp(`^${studentId.trim()}$`, 'i') }
    });

    if (existing) {
      return res.status(409).json({ error: `Student ID "${studentId}" has already submitted a photo` });
    }

    const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype);

    const student = new Student({
      name:       name.trim(),
      studentId:  studentId.trim(),
      department: department.trim(),
      photoUrl:   result.secure_url,
      publicId:   result.public_id
    });

    await student.save();
    console.log(`✅ Saved: ${student.name} (${student.studentId})`);
    res.json({ success: true, message: 'Photo submitted successfully!' });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This Student ID has already submitted' });
    }
    console.error('Submit error:', err.message, err.stack);
    res.status(500).json({ error: err.message || 'Server error. Please try again.' });
  }
});

// Get all students (admin only)
app.get('/api/students', adminAuth, async (req, res) => {
  try {
    const students = await Student.find()
      .select('name studentId department photoUrl submittedAt')
      .sort({ submittedAt: -1 });
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Delete student (admin only)
app.delete('/api/students/:id', adminAuth, async (req, res) => {
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

// Export CSV (admin only)
app.get('/api/export/csv', adminAuth, async (req, res) => {
  try {
    const students = await Student.find().sort({ submittedAt: 1 });
    let csv = 'Name,Student ID,Department,Photo URL,Submitted At\n';
    students.forEach(s => {
      csv += `"${s.name}","${s.studentId}","${s.department || ''}","${s.photoUrl}","${new Date(s.submittedAt).toLocaleString()}"\n`;
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
