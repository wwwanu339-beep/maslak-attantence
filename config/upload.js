const path = require('path');
const fs = require('fs');
const multer = require('multer');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });
const admUploads = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'aadhaar_doc', maxCount: 1 }
]);

const brandingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${file.fieldname}${ext}`);
    }
  })
}).fields([
  { name: 'print_header', maxCount: 1 },
  { name: 'print_footer', maxCount: 1 }
]);

const idBrandingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${file.fieldname}${ext}`);
    }
  })
}).fields([
  { name: 'id_card_header', maxCount: 1 },
  { name: 'id_card_footer', maxCount: 1 }
]);

function getBrandingUrls() {
  const files = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
  const headerFile = files.find(f => f.startsWith('print_header.'));
  const footerFile = files.find(f => f.startsWith('print_footer.'));
  return {
    headerUrl: headerFile ? `/uploads/${headerFile}?v=${Date.now()}` : '',
    footerUrl: footerFile ? `/uploads/${footerFile}?v=${Date.now()}` : ''
  };
}

function getIdBrandingUrls() {
  const files = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
  const idHeaderFile = files.find(f => f.startsWith('id_card_header.'));
  const idFooterFile = files.find(f => f.startsWith('id_card_footer.'));
  return {
    headerUrl: idHeaderFile ? `/uploads/${idHeaderFile}?v=${Date.now()}` : '',
    footerUrl: idFooterFile ? `/uploads/${idFooterFile}?v=${Date.now()}` : ''
  };
}

module.exports = {
  uploadDir,
  admUploads,
  brandingUpload,
  idBrandingUpload,
  getBrandingUrls,
  getIdBrandingUrls
};