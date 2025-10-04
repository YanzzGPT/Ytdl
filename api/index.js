const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// ========================================================================
// [PERBAIKAN HYBRID] Logika untuk mendeteksi lingkungan Vercel vs Lokal
// ========================================================================
let ytDlpPath;
let ffmpegPath;

if (process.env.VERCEL_ENV === 'production') {
    // Lingkungan Vercel: Gunakan path dari paket NPM
    console.log('Running in Vercel environment. Using NPM packages.');
    ytDlpPath = require('yt-dlp-exec').path;
    ffmpegPath = require('ffmpeg-static');
} else {
    // Lingkungan Lokal (Termux/dll): Asumsikan sudah terinstal secara global
    console.log('Running in local environment. Using globally installed binaries.');
    ytDlpPath = 'yt-dlp';
    ffmpegPath = 'ffmpeg';
}


const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Utility functions (tidak berubah)
function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
function formatViews(views) {
    if (!views) return '0';
    if (views >= 1000000) return (views / 1000000).toFixed(1) + 'M';
    if (views >= 1000) return (views / 1000).toFixed(0) + 'K';
    return views.toString();
}
function formatUploadDate(dateString) {
    if (!dateString || dateString.length !== 8) return 'Unknown';
    try {
        const year = dateString.substring(0, 4);
        const month = dateString.substring(4, 6);
        const day = dateString.substring(6, 8);
        const date = new Date(`${year}-${month}-${day}`);
        return date.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) { return dateString; }
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

// Fungsi getVideoInfo menggunakan child_process.exec yang andal
async function getVideoInfo(url) {
    console.log('Getting video info via direct child_process.exec...');
    const command = `"${ytDlpPath}" --dump-json --no-warnings "${url}"`;

    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error || stderr) {
                console.error(`Exec error: ${error ? error.message : 'N/A'}`);
                console.error(`Stderr: ${stderr}`);
                const cleanError = stderr.replace(/ERROR:/g, '').trim();
                return reject(new Error(cleanError || 'Failed to get video data from yt-dlp.'));
            }
            if (!stdout) return reject(new Error('yt-dlp returned empty data.'));

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

// Route untuk mendapatkan info video
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        const { info, method } = await getVideoInfo(url);
        const videoDetails = info.videoDetails;
        
        const videoFormats = (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.height && f.fps)
            .map(f => ({
                quality: `${f.height}p`,
                format: f.ext,
                fps: f.fps,
                size: f.filesize ? formatBytes(f.filesize) : (f.filesize_approx ? formatBytes(f.filesize_approx) : 'Unknown'),
            }))
            .filter((f, i, self) => i === self.findIndex(t => t.quality === f.quality))
            .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));

        const audioFormats = (info.formats || [])
            .filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.abr)
            .map(f => ({
                quality: `${Math.round(f.abr)}kbps`,
                format: f.ext,
                size: f.filesize ? formatBytes(f.filesize) : (f.filesize_approx ? formatBytes(f.filesize_approx) : 'Unknown'),
                audioBitrate: f.abr
            }))
            .filter((f, i, self) => i === self.findIndex(t => t.quality === f.quality))
            .sort((a, b) => b.audioBitrate - a.audioBitrate);

        res.json({
            title: videoDetails.title || 'Unknown Title',
            thumbnail: videoDetails.thumbnails?.pop()?.url || '',
            duration: formatDuration(videoDetails.lengthSeconds),
            views: formatViews(videoDetails.viewCount),
            uploadDate: formatUploadDate(videoDetails.publishDate),
            channel: videoDetails.author ? videoDetails.author.name : 'Unknown',
            formats: { video: videoFormats, audio: audioFormats },
            method: method,
            downloadAvailable: videoFormats.length > 0 || audioFormats.length > 0
        });
    } catch (error) {
        console.error('Error in video info route:', error.message);
        res.status(500).json({ error: 'Failed to process video information', details: error.message });
    }
});

// Route /api/download sekarang menggunakan Stream
app.get('/api/download', (req, res) => {
    try {
        const { url, format, quality } = req.query;
        if (!url || !format || !quality) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        console.log(`Download request: ${format} ${quality} from ${url}`);

        let formatString;
        if (format === 'video') {
            const height = quality.replace('p', '');
            // Meminta penggabungan video + audio terbaik, memerlukan ffmpeg
            formatString = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]`;
        } else {
            formatString = 'bestaudio/best';
        }

        // Jalankan perintah untuk mendapatkan nama file
        const filenameCommand = `"${ytDlpPath}" --get-filename -o "%(title)s.%(ext)s" "${url}"`;
        exec(filenameCommand, (err, stdout, stderr) => {
            if (err || stderr) {
                console.error("Couldn't get filename:", stderr);
                // Fallback filename
                res.setHeader('Content-Disposition', `attachment; filename="download.mp4"`);
            } else {
                res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(stdout.trim())}"`);
            }

            const downloadProcess = spawn(ytDlpPath, [
                url,
                '-f', formatString,
                '--ffmpeg-location', ffmpegPath, // Selalu berikan lokasi ffmpeg
                '-o', '-', // Output ke stdout
                '--no-warnings'
            ]);
    
            downloadProcess.stdout.pipe(res);
    
            downloadProcess.stderr.on('data', (data) => {
                console.error(`yt-dlp stderr: ${data}`);
            });
    
            downloadProcess.on('error', (error) => {
                console.error('Download process error:', error);
                if (!res.headersSent) {
                    res.status(500).send('Failed to start download stream.');
                }
            });
    
            downloadProcess.on('close', (code) => {
                console.log(`Download process exited with code ${code}`);
                res.end();
            });
        });

    } catch (error) {
        console.error('Error in download route:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to prepare download', details: error.message });
        }
    }
});


// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({ message: 'API is working!' });
});

// Start server (hanya untuk pengembangan lokal)
if (process.env.VERCEL_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`\n🚀 Server started locally on http://localhost:${PORT}`);
    });
}

// Ekspor app untuk Vercel
module.exports = app;