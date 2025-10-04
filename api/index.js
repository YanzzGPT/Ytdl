const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const YTDlpWrap = require('yt-dlp-wrap').default; // Masih digunakan untuk inisialisasi path
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process'); // Mengimpor 'exec' langsung dari Node.js
const { installYtDlp, ytDlpPath } = require('./install-ytdlp');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://0.0.0.0:3000'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
const publicPath = path.join(__dirname, '../public');
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
}

// Rate limiting
const downloadAttempts = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60000;

// Global variable for yt-dlp wrapper (hanya untuk unduhan)
let ytDlpWrapper = null;

// Initialize yt-dlp
async function initializeYtDlp() {
    try {
        await installYtDlp(); // Cukup pastikan file eksekusinya ada dan bisa dijalankan
        ytDlpWrapper = new YTDlpWrap(ytDlpPath);
        console.log('yt-dlp executable is ready at:', ytDlpPath);
        return true;
    } catch (error) {
        console.error('Failed to initialize yt-dlp:', error.message);
        return false;
    }
}

// Utility functions
function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatViews(views) {
    if (!views) return '0';
    if (views >= 1000000) {
        return (views / 1000000).toFixed(1) + 'M';
    } else if (views >= 1000) {
        return (views / 1000).toFixed(0) + 'K';
    }
    return views.toString();
}

function formatUploadDate(dateString) {
    if (!dateString || dateString.length !== 8) return 'Unknown';
    try {
        const year = dateString.substring(0, 4);
        const month = dateString.substring(4, 6);
        const day = dateString.substring(6, 8);
        const date = new Date(`${year}-${month}-${day}`);
        return date.toLocaleDateString('id-ID', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    } catch (e) {
        return dateString;
    }
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function sanitizeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9\s-_.]/g, '_').substring(0, 100);
}

function checkRateLimit(ip) {
    const now = Date.now();
    const attempts = downloadAttempts.get(ip) || [];
    const validAttempts = attempts.filter(time => now - time < RATE_WINDOW);
    if (validAttempts.length >= RATE_LIMIT) return false;
    validAttempts.push(now);
    downloadAttempts.set(ip, validAttempts);
    return true;
}


// ====================================================================================
// [PERBAIKAN TOTAL DAN FINAL] Menggunakan child_process.exec untuk keandalan maksimal
// ====================================================================================
async function getVideoInfo(url) {
    if (!fs.existsSync(ytDlpPath)) {
        throw new Error('yt-dlp executable not found.');
    }

    console.log('Getting video info via direct child_process.exec...');

    // Pastikan path dan URL diapit oleh tanda kutip untuk menangani karakter khusus
    const command = `"${ytDlpPath}" --dump-json --no-warnings "${url}"`;

    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            // Jika ada 'error' atau 'stderr', berarti gagal
            if (error || stderr) {
                console.error(`Exec error: ${error ? error.message : 'N/A'}`);
                console.error(`Stderr: ${stderr}`);
                const cleanError = stderr.replace(/ERROR:/g, '').trim();
                return reject(new Error(cleanError || 'Failed to get video data from yt-dlp.'));
            }

            // Jika berhasil tapi output kosong
            if (!stdout) {
                return reject(new Error('yt-dlp returned empty data.'));
            }

            // Coba parse JSON
            try {
                const info = JSON.parse(stdout);
                const convertedInfo = {
                    videoDetails: {
                        title: info.title,
                        viewCount: info.view_count,
                        lengthSeconds: info.duration,
                        publishDate: info.upload_date,
                        author: { name: info.uploader },
                        thumbnails: info.thumbnails,
                    },
                    formats: info.formats || [],
                };
                console.log('Successfully parsed video info from direct exec.');
                resolve({ info: convertedInfo, method: 'direct-exec' });
            } catch (parseError) {
                console.error('Failed to parse yt-dlp JSON output:', stdout);
                reject(new Error('Could not parse video information.'));
            }
        });
    });
}

// Fungsi downloadWithYtDlp masih bisa menggunakan wrapper karena lebih mudah untuk progress tracking
async function downloadWithYtDlp(url, format, quality, res) {
    return new Promise((resolve, reject) => {
        const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/)[1];
        const tempDir = path.join(__dirname, 'temp');
        
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const outputFilename = `${sanitizeFilename(videoId)}_${Date.now()}.%(ext)s`;
        const outputPath = path.join(tempDir, outputFilename);
        
        let formatString;
        if (format === 'video') {
            const height = quality.replace('p', '');
            formatString = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best[height<=${height}]`;
        } else {
            formatString = 'bestaudio[ext=m4a]/bestaudio';
        }
        
        const args = [
            url,
            '--no-warnings',
            '--no-call-home',
            '--no-check-certificate',
            '-f', formatString,
            '-o', outputPath,
            '--embed-thumbnail',
            '--embed-metadata',
            '--progress'
        ];

        if (format === 'audio') {
            args.push('--extract-audio', '--audio-format', 'mp3');
        }
        
        console.log(`Downloading with yt-dlp using args: ${args.join(' ')}`);
        
        const ytDlpProcess = ytDlpWrapper.exec(args);
        
        ytDlpProcess.on('progress', (progress) => {
            const percent = progress.percent;
            if (percent) {
                res.write(`data: ${JSON.stringify({ type: 'progress', percent })}\n\n`);
            }
        });

        let lastError = '';
        ytDlpProcess.on('error', (error) => {
            console.error('yt-dlp process error:', error.message);
            lastError = error.message;
        });

        ytDlpProcess.on('close', (code) => {
            if (code === 0) {
                 const files = fs.readdirSync(tempDir).filter(f => f.startsWith(sanitizeFilename(videoId)));
                if (files.length > 0) {
                    const finalFilename = files[0];
                    console.log('Download finished, file:', finalFilename);
                    res.write(`data: ${JSON.stringify({ type: 'complete', filename: finalFilename })}\n\n`);
                    res.end();
                    resolve();
                } else {
                    reject(new Error('Downloaded file not found in temp directory.'));
                }
            } else {
                console.error(`yt-dlp exited with code ${code}. Last error: ${lastError}`);
                reject(new Error(`yt-dlp failed with code ${code}. Error: ${lastError || 'Unknown error'}`));
            }
        });
    });
}

// Middleware untuk logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'API is working!',
        timestamp: new Date().toISOString(),
        ytDlpInstalled: fs.existsSync(ytDlpPath)
    });
});

// Route untuk mendapatkan info video
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url || !ytdl.validateURL(url)) {
            return res.status(400).json({ 
                error: 'Invalid or missing YouTube URL',
                details: 'Please provide a valid YouTube video URL'
            });
        }

        const { info, method } = await getVideoInfo(url);
        console.log(`Video info fetched using: ${method}`);
        
        const videoDetails = info.videoDetails;
        
        const videoFormatsMap = new Map();
        (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.height && f.fps) 
            .forEach(f => {
                const quality = f.height ? `${f.height}p` : f.format_note;
                if (!videoFormatsMap.has(quality) || (f.acodec !== 'none' && !videoFormatsMap.get(quality).hasAudio)) {
                    videoFormatsMap.set(quality, {
                        quality: quality,
                        format: f.ext || 'mp4',
                        fps: f.fps,
                        size: f.filesize ? formatBytes(f.filesize) : (f.filesize_approx ? formatBytes(f.filesize_approx) : 'Unknown'),
                        hasAudio: f.acodec !== 'none'
                    });
                }
            });

        const videoFormats = Array.from(videoFormatsMap.values())
            .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));

        const audioFormatsMap = new Map();
        (info.formats || [])
            .filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.abr) 
            .forEach(f => {
                 const quality = `${Math.round(f.abr)}kbps`;
                 if (!audioFormatsMap.has(quality)) {
                     audioFormatsMap.set(quality, {
                        quality: quality,
                        format: f.ext || 'm4a',
                        size: f.filesize ? formatBytes(f.filesize) : (f.filesize_approx ? formatBytes(f.filesize_approx) : 'Unknown'),
                        audioBitrate: f.abr
                    });
                 }
            });
        
        const audioFormats = Array.from(audioFormatsMap.values())
            .sort((a, b) => b.audioBitrate - a.audioBitrate);

        const responseData = {
            title: videoDetails.title || 'Unknown Title',
            thumbnail: videoDetails.thumbnails && videoDetails.thumbnails.length > 0 
                ? videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url 
                : '',
            duration: formatDuration(videoDetails.lengthSeconds),
            views: formatViews(videoDetails.viewCount),
            uploadDate: formatUploadDate(videoDetails.publishDate),
            channel: videoDetails.author ? videoDetails.author.name : 'Unknown',
            formats: {
                video: videoFormats,
                audio: audioFormats
            },
            videoUrl: url,
            method: method,
            downloadAvailable: videoFormats.length > 0 || audioFormats.length > 0
        };

        res.json(responseData);

    } catch (error) {
        console.error('Error in video info route:', error.message);
        res.status(500).json({ 
            error: 'Failed to process video information',
            details: error.message 
        });
    }
});


// Sisa kode dari sini ke bawah tetap sama
app.get('/api/download', async (req, res) => {
    try {
        const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
        
        if (!checkRateLimit(clientIP)) {
            return res.status(429).json({ 
                error: 'Too many download attempts',
                details: 'Please wait a minute before trying again'
            });
        }

        const { url, format, quality } = req.query; 
        
        if (!url || !format || !quality || !ytdl.validateURL(url)) {
            return res.status(400).json({ 
                error: 'Missing or invalid required parameters',
                details: 'A valid url, format, and quality are required'
            });
        }

        console.log(`Download request: ${format} ${quality} from ${url}`);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        if (ytDlpWrapper) {
            await downloadWithYtDlp(url, format, quality, res);
        } else {
            const errorMessage = JSON.stringify({ type: 'error', message: 'yt-dlp is not available on the server. Download cannot proceed.' });
            res.write(`data: ${errorMessage}\n\n`);
            res.end();
        }

    } catch (error) {
        console.error('Error preparing download:', error);
        const errorMessage = JSON.stringify({ type: 'error', message: `Server error: ${error.message}` });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to prepare download', details: error.message });
        } else {
            res.write(`data: ${errorMessage}\n\n`);
            res.end();
        }
    }
});

app.get('/api/get-file/:filename', (req, res) => {
    const { filename } = req.params;
    
    if (filename.includes('..') || filename.includes('/')) {
        return res.status(400).send('Invalid filename');
    }
    
    const tempDir = path.join(__dirname, 'temp');
    const filePath = path.join(tempDir, filename);

    if (fs.existsSync(filePath)) {
        res.download(filePath, (err) => {
            if (err) {
                console.error('Error sending file:', err);
            }
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) {
                    console.error('Error deleting temp file:', unlinkErr);
                } else {
                    console.log('Successfully deleted temp file:', filename);
                }
            });
        });
    } else {
        res.status(404).send('File not found or has expired.');
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        ytDlpInstalled: fs.existsSync(ytDlpPath),
        ytDlpPath: ytDlpPath.toString()
    });
});

app.get('/', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Index file not found. Make sure index.html is in the /public directory.');
    }
});

const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 Server started successfully!`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`📍 Network: http://0.0.0.0:${PORT}`);
    
    await initializeYtDlp();
    
    console.log(`⚠️  For educational purposes only\n`);
});

server.on('error', (error) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
    }
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
    });
});