const express = require('express');
const multer = require('multer');
const SFTPClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const dotenv = require('dotenv');
const mime = require('mime-types'); // For detecting MIME types
const { createClient } = require('webdav'); // Correct import for webdav
const app = express();

// Load environment variables from .env file
dotenv.config();

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const LOCAL_MEDIA_DIR = process.env.LOCAL_MEDIA_DIR;
const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL;
const NEXTCLOUD_USER = process.env.NEXTCLOUD_USER;
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD;
const NEXTCLOUD_DIR = process.env.NEXTCLOUD_DIR;
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = process.env.SFTP_PORT || 22;
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_DIR = process.env.SFTP_DIR || '/';
const UPLOAD_ALLOWED_IP = process.env.UPLOAD_ALLOWED_IP;
const UPLOAD_LIMIT_MB = parseInt(process.env.UPLOAD_LIMIT_MB, 10) || 700;

// Ensure local media directory exists
if (!fs.existsSync(LOCAL_MEDIA_DIR)) {
    fs.mkdirSync(LOCAL_MEDIA_DIR, { recursive: true });
}

// Configure multer to store files in a specific directory
const upload = multer({
    dest: LOCAL_MEDIA_DIR,
    limits: { fileSize: UPLOAD_LIMIT_MB * 1024 * 1024 }
});

// Middleware to check IP address for uploads and folder creation
function ipRestrict(req, res, next) {
    const clientIp = req.ip;
    console.log(`Client IP: ${clientIp}`);
    
    if (clientIp === UPLOAD_ALLOWED_IP) {
        next();
    } else {
        res.status(403).send('Forbidden: You are not allowed to perform this action.');
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

// Function to list media files from SFTP, local directory, and Nextcloud
async function listMedia() {
    let sftp;
    const mediaItems = [];

    try {
        // List files from SFTP
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

        // List files from local directory
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

        // List files from Nextcloud
        const client = createClient(NEXTCLOUD_URL, {
            username: NEXTCLOUD_USER,
            password: NEXTCLOUD_PASSWORD
        });

        const nextcloudFileList = await client.getDirectoryContents(NEXTCLOUD_DIR);

        for (const file of nextcloudFileList) {
            const ext = path.extname(file.name).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/nextcloud/${encodeURIComponent(file.name)}`;
                const fileStat = await client.getStats(path.join(NEXTCLOUD_DIR, file.name));
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

        mediaItems.sort((a, b) => (a.uploadDate instanceof Date && b.uploadDate instanceof Date) ? b.uploadDate - a.uploadDate : 0);

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

// Serve static files
app.use(express.static('public'));
app.use('/local', express.static(LOCAL_MEDIA_DIR));
app.use('/nextcloud', express.static(NEXTCLOUD_DIR));
app.use('/media', express.static(path.join(LOCAL_MEDIA_DIR, 'media'))); // Serve media files from SFTP
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
            background: rgba(0, 0, 0, 0.9);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }
        .fullscreen img {
            max-width: 90%;
            max-height: 90%;
        }
        .fullscreen video {
            max-width: 90%;
            max-height: 90%;
        }
        .fullscreen-close {
            position: absolute;
            top: 20px;
            right: 20px;
            font-size: 24px;
            color: white;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <h1>Media Gallery</h1>
    <div class="gallery">
        ${media.map(({ url, size, uploadDate }) => {
            const dateStr = uploadDate instanceof Date ? uploadDate.toISOString().split('T')[0] : uploadDate;
            const isVideo = url.endsWith('.mp4') || url.endsWith('.avi') || url.endsWith('.mov');
            const type = isVideo ? 'video' : 'img';
            return `
                <div class="gallery-item">
                    <${type} src="${url}" controls="controls" style="max-height: 200px;"></${type}>
                    <div class="info">
                        <div>Size: ${(size / (1024 * 1024)).toFixed(2)} MB</div>
                        <div>Upload Date: ${dateStr}</div>
                        <a class="download-button" href="${url}" download>Download</a>
                    </div>
                </div>
            `;
        }).join('')}
    </div>
    <div id="fullscreen" class="fullscreen">
        <div class="fullscreen-close" onclick="window.location='#'">✖</div>
        <img id="fullscreen-img" src="" alt="">
        <video id="fullscreen-video" controls="controls" style="display:none;"></video>
    </div>
    <script>
        document.querySelectorAll('.gallery-item').forEach(item => {
            item.addEventListener('click', () => {
                const isVideo = item.querySelector('video');
                if (isVideo) {
                    document.getElementById('fullscreen-video').src = isVideo.src;
                    document.getElementById('fullscreen-img').style.display = 'none';
                    document.getElementById('fullscreen-video').style.display = 'block';
                } else {
                    document.getElementById('fullscreen-img').src = item.querySelector('img').src;
                    document.getElementById('fullscreen-video').style.display = 'none';
                    document.getElementById('fullscreen-img').style.display = 'block';
                }
                window.location = '#fullscreen';
            });
        });
    </script>
</body>
</html>
`;

// Route to serve gallery
app.get('/gallery', async (req, res) => {
    const mediaItems = await listMedia();
    res.send(galleryTemplate(mediaItems));
});

// Route to handle file uploads
app.post('/upload', ipRestrict, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }

        // Save to local directory
        const localFilePath = path.join(LOCAL_MEDIA_DIR, req.file.originalname);
        fs.renameSync(req.file.path, localFilePath);

        // Optionally, upload to SFTP
        const sftp = await createSFTPConnection();
        await sftp.put(localFilePath, path.join(SFTP_DIR, req.file.originalname));
        await sftp.end();

        res.send('File uploaded successfully.');
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error.');
    }
});

// Route to create a new folder (only allowed IP)
app.post('/create-folder', ipRestrict, express.urlencoded({ extended: true }), (req, res) => {
    const folderName = req.body.folderName;
    if (!folderName) {
        return res.status(400).send('Folder name is required.');
    }

    const folderPath = path.join(LOCAL_MEDIA_DIR, folderName);
    if (fs.existsSync(folderPath)) {
        return res.status(400).send('Folder already exists.');
    }

    fs.mkdirSync(folderPath, { recursive: true });
    res.send('Folder created successfully.');
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
