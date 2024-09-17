const express = require('express');
const multer = require('multer');
const SFTPClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const axios = require('axios');
const mime = require('mime-types'); // For detecting MIME types

const app = express();

// Load environment variables from .env file
dotenv.config();

// Environment variables
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = process.env.SFTP_PORT || 22;
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_DIR = process.env.SFTP_DIR || '/';
const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL;
const NEXTCLOUD_USER = process.env.NEXTCLOUD_USER;
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD;
const UPLOAD_ALLOWED_IP = process.env.UPLOAD_ALLOWED_IP;
const LOCAL_MEDIA_DIR = 'local_media/';
const UPLOAD_LIMIT_MB = parseInt(process.env.UPLOAD_LIMIT_MB, 10) || 700;

// Configure multer
const upload = multer({
    dest: LOCAL_MEDIA_DIR,
    limits: { fileSize: UPLOAD_LIMIT_MB * 1024 * 1024 } // Limit file size
});

// Ensure local media directory exists
if (!fs.existsSync(LOCAL_MEDIA_DIR)){
    fs.mkdirSync(LOCAL_MEDIA_DIR);
}

// Trust the X-Forwarded-For header if using a proxy
app.set('trust proxy', true);

// Middleware to check IP address for uploads
function ipRestrict(req, res, next) {
    const clientIp = req.ip;
    console.log(`Client IP: ${clientIp}`);
    
    if (clientIp === UPLOAD_ALLOWED_IP) {
        next();
    } else {
        res.status(403).send('Forbidden: You are not allowed to upload.');
    }
}

// Function to create a new SFTP client connection
async function createSFTPConnection() {
    const sftp = new SFTPClient();
    await sftp.connect({
        host: SFTP_HOST,
        port: SFTP_PORT,
        username: SFTP_USER,
        password: SFTP_PASSWORD
    });
    return sftp;
}

// Function to list media files from SFTP
async function listSFTPFiles() {
    let sftp;
    const mediaItems = [];
    try {
        sftp = await createSFTPConnection();
        const sftpFileList = await sftp.list(SFTP_DIR);

        for (const file of sftpFileList) {
            const ext = path.extname(file.name).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/media/${encodeURIComponent(file.name)}`;
                const fileStat = await sftp.stat(path.join(SFTP_DIR, file.name));
                let uploadDate = new Date(fileStat.mtime);
                if (isNaN(uploadDate)) {
                    uploadDate = 'Unknown Date';
                }

                mediaItems.push({
                    url: fileUrl,
                    size: fileStat.size,
                    uploadDate: uploadDate instanceof Date ? uploadDate : 'Unknown Date'
                });
            }
        }

        return mediaItems;
    } catch (error) {
        console.error(error);
        return [];
    } finally {
        if (sftp) {
            await sftp.end();
        }
    }
}

// Function to list media files from local directory
async function listLocalFiles() {
    const mediaItems = [];
    try {
        const localFileList = fs.readdirSync(LOCAL_MEDIA_DIR);

        for (const file of localFileList) {
            const ext = path.extname(file).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/local/${encodeURIComponent(file)}`;
                const filePath = path.join(LOCAL_MEDIA_DIR, file);
                const fileStat = fs.statSync(filePath);
                let uploadDate = new Date(fileStat.mtime);
                if (isNaN(uploadDate)) {
                    uploadDate = 'Unknown Date';
                }

                mediaItems.push({
                    url: fileUrl,
                    size: fileStat.size,
                    uploadDate: uploadDate instanceof Date ? uploadDate : 'Unknown Date'
                });
            }
        }

        return mediaItems;
    } catch (error) {
        console.error(error);
        return [];
    }
}

// Function to list media files from Nextcloud
async function listNextcloudFiles() {
    try {
        const response = await axios({
            method: 'get',
            url: `${NEXTCLOUD_URL}/remote.php/dav/files/${NEXTCLOUD_USER}/`,
            auth: {
                username: NEXTCLOUD_USER,
                password: NEXTCLOUD_PASSWORD
            },
            responseType: 'text'
        });

        // Parse the XML response from Nextcloud
        const xml = response.data;
        const mediaItems = [];
        const fileRegex = /<d:response>[\s\S]*?<d:href>([\s\S]*?)<\/d:href>[\s\S]*?<d:getcontentlength>(\d+)<\/d:getcontentlength>/g;
        let match;

        while ((match = fileRegex.exec(xml)) !== null) {
            const fileUrl = match[1];
            const fileSize = parseInt(match[2], 10);
            const ext = path.extname(fileUrl).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                mediaItems.push({
                    url: fileUrl,
                    size: fileSize,
                    uploadDate: 'Unknown Date' // Nextcloud may not provide this in the response
                });
            }
        }

        return mediaItems;
    } catch (error) {
        console.error('Error fetching Nextcloud files:', error);
        return [];
    }
}

// List all media from SFTP, local, and Nextcloud
async function listAllMedia() {
    const sftpMedia = await listSFTPFiles();
    const localMedia = await listLocalFiles();
    const nextcloudMedia = await listNextcloudFiles();

    const allMedia = [...sftpMedia, ...localMedia, ...nextcloudMedia];

    return allMedia.sort((a, b) => (a.uploadDate instanceof Date && b.uploadDate instanceof Date) ? b.uploadDate - a.uploadDate : 0);
}

// Serve static files
app.use(express.static('public'));
app.use('/local', express.static(LOCAL_MEDIA_DIR));
app.use('/media', express.static('/remote.php/dav/files/'));
app.use(express.urlencoded({ extended: true }));

// Define the HTML template for the gallery
const galleryTemplate = (media) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Media Gallery</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background-color: #f0f0f0;
            color: #333;
            margin: 0;
            padding: 0;
        }
        h1 {
            text-align: center;
            padding: 20px;
        }
        .gallery {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            justify-content: center;
            padding: 20px;
        }
        .gallery-item {
            position: relative;
            background-color: #fff;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            max-width: 300px;
            margin: 10px;
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
        }
        .gallery-item img {
            display: block;
            width: 100%;
            height: auto;
            object-fit: cover;
        }
        .gallery-item video {
            display: block;
            width: 100%;
            height: auto;
            object-fit: cover;
        }
        .info {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            background: rgba(0, 0, 0, 0.6);
            color: white;
            padding: 10px;
            font-size: 14px;
            display: none;
            text-align: center;
        }
        .gallery-item:hover .info {
            display: block;
        }
        .download-button {
            display: block;
            margin: 10px;
            padding: 10px;
            background: #007bff;
            color: white;
            text-align: center;
            text-decoration: none;
            border-radius: 5px;
            width: calc(100% - 20px);
            font-size: 14px;
            box-sizing: border-box;
        }
        .download-button:hover {
            background: #0056b3;
        }
        .fullscreen {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            justify-content: center;
            align-items: center;
            z-index: 1000;
        }
        .fullscreen img, .fullscreen video {
            max-width: 90%;
            max-height: 90%;
        }
        .fullscreen .close {
            position: absolute;
            top: 20px;
            right: 20px;
            color: white;
            font-size: 24px;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <h1>Media Gallery</h1>
    <div class="gallery">
        ${media.map(item => `
            <div class="gallery-item" onclick="showFullscreen('${item.url}')">
                ${item.url.endsWith('.mp4') ? `<video src="${item.url}" controls></video>` : `<img src="${item.url}" alt="${item.url}">`}
                <div class="info">
                    <p>Size: ${Math.round(item.size / 1024 / 1024)} MB</p>
                    <p>Upload Date: ${item.uploadDate instanceof Date ? item.uploadDate.toLocaleDateString() : 'Unknown'}</p>
                </div>
            </div>
        `).join('')}
    </div>
    <div class="fullscreen" id="fullscreen">
        <span class="close" onclick="closeFullscreen()">&times;</span>
        <img id="fullscreenImage" src="" alt="">
        <video id="fullscreenVideo" controls src=""></video>
    </div>
    <script>
        function showFullscreen(url) {
            const fullscreen = document.getElementById('fullscreen');
            const fullscreenImage = document.getElementById('fullscreenImage');
            const fullscreenVideo = document.getElementById('fullscreenVideo');
            
            if (url.endsWith('.mp4')) {
                fullscreenVideo.src = url;
                fullscreenImage.style.display = 'none';
                fullscreenVideo.style.display = 'block';
            } else {
                fullscreenImage.src = url;
                fullscreenVideo.style.display = 'none';
                fullscreenImage.style.display = 'block';
            }
            
            fullscreen.style.display = 'flex';
        }
        function closeFullscreen() {
            const fullscreen = document.getElementById('fullscreen');
            fullscreen.style.display = 'none';
        }
    </script>
</body>
</html>
`;

// Routes
app.get('/', async (req, res) => {
    try {
        const media = await listAllMedia();
        res.send(galleryTemplate(media));
    } catch (error) {
        console.error('Error generating gallery:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/upload', ipRestrict, upload.single('file'), (req, res) => {
    res.send('File uploaded successfully');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
