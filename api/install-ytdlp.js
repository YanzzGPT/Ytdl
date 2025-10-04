const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');

const ytDlpPath = path.join(__dirname, 'yt-dlp');
const ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// Fungsi untuk mengunduh file dan menangani redirect
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                console.log(`Redirected to: ${response.headers.location}`);
                downloadFile(response.headers.location, dest)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            // Handle non-successful status codes
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download yt-dlp: Status Code ${response.statusCode}`));
                return;
            }

            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        });

        request.on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

async function installYtDlp() {
    console.log('Checking yt-dlp installation...');

    // Cek apakah file sudah ada dan bisa dieksekusi
    if (fs.existsSync(ytDlpPath)) {
        try {
            // Coba jalankan perintah version untuk memverifikasi
            await new Promise((resolve, reject) => {
                exec(`"${ytDlpPath}" --version`, (error, stdout, stderr) => {
                    if (error) {
                        return reject(error);
                    }
                    console.log(`yt-dlp is already installed. Version: ${stdout.trim()}`);
                    resolve();
                });
            });
            return ytDlpPath; // Jika berhasil, langsung kembalikan path
        } catch (error) {
            console.log(`yt-dlp check failed: ${error.message}`);
            console.log('File exists but is not working. Re-downloading...');
            // Hapus file yang rusak agar bisa diunduh ulang
            fs.unlinkSync(ytDlpPath);
        }
    }

    // Jika file tidak ada atau rusak, unduh yang baru
    console.log('Downloading latest yt-dlp...');
    try {
        await downloadFile(ytDlpUrl, ytDlpPath);
        console.log('yt-dlp downloaded successfully.');
        
        // **[PERBAIKAN PENTING]** Berikan izin eksekusi pada file
        console.log('Setting executable permissions for yt-dlp...');
        fs.chmodSync(ytDlpPath, '755'); // '755' berarti rwxr-xr-x
        console.log('Permissions set successfully.');

        return ytDlpPath;
    } catch (error) {
        console.error(`Failed to install yt-dlp: ${error.message}`);
        throw error;
    }
}

module.exports = { installYtDlp, ytDlpPath };