const express = require('express');
const multer = require('multer');
const SFTPClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const dotenv = require('dotenv');
const mime = require('mime-types'); // For detecting MIME types
const app = express();

// Load environment variables from .env file
dotenv.config();

// SFTP configuration from environment variables
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = process.env.SFTP_PORT || 22;
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_DIR = process.env.SFTP_DIR || '/';

// Nextcloud configuration from environment variables
const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL;
const NEXTCLOUD_USER = process.env.NEXTCLOUD_USER;
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD;

// Allowed IP address for uploading and folder creation
const ALLOWED_IP = process.env.ALLOWED_IP;

// Local media storage directory
const LOCAL_MEDIA_DIR = 'local_media/';

// Upload limit from environment variable (default to 700 MB)
const UPLOAD_LIMIT_MB = parseInt(process.env.UPLOAD_LIMIT_MB, 10) || 700;

// Configure multer to store files in a specific directory
const upload = multer({
    dest: LOCAL_MEDIA_DIR, // Directory to store uploaded files
    limits: { fileSize: UPLOAD_LIMIT_MB * 1024 * 1024 } // Limit file size to configured limit
});

// Ensure local media directory exists
if (!fs.existsSync(LOCAL_MEDIA_DIR)){
    fs.mkdirSync(LOCAL_MEDIA_DIR);
}

// Trust the X-Forwarded-For header to get the correct client IP if using a proxy
app.set('trust proxy', true);

// Middleware to check IP address for uploads and folder creation
function ipRestrict(req, res, next) {
    const clientIp = req.ip;
    console.log(`Client IP: ${clientIp}`);
    
    if (clientIp === ALLOWED_IP) {
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

// Function to list media files from local directory and SFTP
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

// Dynamically import the webdav package
let webdav;
async function getWebDAVClient() {
    if (!webdav) {
        const { createClient } = await import('webdav');
        webdav = createClient(NEXTCLOUD_URL, {
            username: NEXTCLOUD_USER,
            password: NEXTCLOUD_PASSWORD
        });
    }
    return webdav;
}

// Route to serve media from local storage
app.use('/local', express.static(LOCAL_MEDIA_DIR));

// Route to serve media from SFTP
app.get('/media/:filename', async (req, res) => {
    const { filename } = req.params;
    let sftp;
    try {
        sftp = await createSFTPConnection();
        const remoteFilePath = path.join(SFTP_DIR, filename);
        const sftpStream = await sftp.get(remoteFilePath);

        if (Buffer.isBuffer(sftpStream)) {
            const stream = new PassThrough();
            stream.end(sftpStream);

            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
            stream.pipe(res);
        } else {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
            sftpStream.pipe(res);
        }

    } catch (error) {
        console.error(error);
        res.status(500).send('Error retrieving file.');
    } finally {
        if (sftp) {
            await sftp.end();
        }
    }
});

// Route to serve media from Nextcloud
app.get('/nextcloud/:filename', async (req, res) => {
    const { filename } = req.params;
    try {
        const client = await getWebDAVClient();
        const stream = await client.createReadStream(filename);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        stream.pipe(res);

    } catch (error) {
        console.error(error);
        res.status(500).send('Error retrieving file from Nextcloud.');
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
        .gallery-item img, .gallery-item video {
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
            background: rgba(0, 0, 0, 0.7);
            color: #fff;
            padding: 10px;
            display: none;
            text-align: center;
        }
        .gallery-item:hover .info {
            display: block;
        }
    </style>
</head>
<body>
    <h1>Media Gallery</h1>
    <div class="gallery">
        ${media.map(item => `
            <div class="gallery-item">
                ${item.url.endsWith('.mp4') ? 
                    `<video controls>
                        <source src="${item.url}" type="video/mp4">
                        Your browser does not support the video tag.
                    </video>` : 
                    `<img src="${item.url}" alt="${item.url}">`
                }
                <div class="info">
                    <p>Size: ${(item.size / 1024 / 1024).toFixed(2)} MB</p>
                    <p>Upload Date: ${item.uploadDate}</p>
                </div>
            </div>`
        ).join('')}
    </div>
</body>
</html>
`;

// Route to display the media gallery
app.get('/gallery', async (req, res) => {
    try {
        const mediaItems = await listMedia();
        res.send(galleryTemplate(mediaItems));
    } catch (error) {
        console.error(error);
        res.status(500).send('Error displaying media gallery.');
    }
});

// Route to handle file uploads
app.post('/upload', upload.single('file'), (req, res) => {
    res.send('File uploaded successfully.');
});

// Serve static files for the local media directory
app.use('/local', express.static(LOCAL_MEDIA_DIR));

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
