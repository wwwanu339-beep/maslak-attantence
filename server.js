const db = require('./config/db');
const session = require('express-session');

// സെഷൻ മിഡിൽവെയർ (Middleware സെക്ഷനിൽ ചേർക്കുക)
app.use(session({
  secret: 'attendance_secret_key_123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 ദിവസം
}));
