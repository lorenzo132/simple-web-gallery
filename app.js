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

// Allowed IP address for uploading videos and managing folders
const ALLOWED_IP = process.env.ALLOWED_IP;

// Local video storage directory
const LOCAL_VIDEO_DIR = 'local_videos/';

// Upload limit from environment variable (default to 700 MB)
const UPLOAD_LIMIT_MB = parseInt(process.env.UPLOAD_LIMIT_MB, 10) || 700;

// Configure multer to store files in a specific directory
const upload = multer({
    dest: LOCAL_VIDEO_DIR, // Directory to store uploaded files
    limits: { fileSize: UPLOAD_LIMIT_MB * 1024 * 1024 } // Limit file size to configured limit
});

// Ensure local video directory exists
if (!fs.existsSync(LOCAL_VIDEO_DIR)) {
    fs.mkdirSync(LOCAL_VIDEO_DIR);
}

// Trust the X-Forwarded-For header to get the correct client IP if using a proxy
app.set('trust proxy', true);

// Middleware to check IP address for uploads and folder management
function ipRestrict(req, res, next) {
    const clientIp = req.ip;
    console.log(`Client IP: ${clientIp}`);
    
    if (clientIp === ALLOWED_IP) {
        next();
    } else {
        res.status(403).send('Forbidden: You are not allowed to upload.');
    }
}

// Middleware to check IP address for folder management
function folderManagementIpRestrict(req, res, next) {
    const clientIp = req.ip;
    console.log(`Client IP: ${clientIp}`);
    
    if (clientIp === ALLOWED_IP) {
        next();
    } else {
        res.status(403).send('Forbidden: You are not allowed to manage folders.');
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

// Function to list media files from both SFTP and local directories
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
        const localFileList = fs.readdirSync(LOCAL_VIDEO_DIR);

        for (const file of localFileList) {
            const ext = path.extname(file).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/local/${encodeURIComponent(file)}`;
                const filePath = path.join(LOCAL_VIDEO_DIR, file);
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

// Serve static files
app.use(express.static('public'));
app.use('/local', express.static(LOCAL_VIDEO_DIR));
app.use(express.urlencoded({ extended: true }));

// Define the HTML template for the gallery with folder management
const galleryTemplate = (media, showFolderButtons) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Media Gallery</title>
    <style>
        /* Your existing CSS here */
    </style>
</head>
<body>
    <h1>Media Gallery</h1>
    ${showFolderButtons ? `
    <div>
        <h2>Manage Folders</h2>
        <form action="/create-folder" method="post">
            <input type="text" name="folderName" placeholder="New folder name" required>
            <button type="submit">Create Folder</button>
        </form>
        <form action="/delete-folder" method="post">
            <input type="text" name="folderName" placeholder="Folder name to delete" required>
            <button type="submit">Delete Folder</button>
        </form>
    </div>
    ` : ''}
    <div class="gallery">
        ${media.map(({ url, size, uploadDate }) => {
            const dateStr = uploadDate instanceof Date ? uploadDate.toDateString() : 'Unknown Date';
            const isVideo = url.endsWith('.mp4') || url.endsWith('.avi') || url.endsWith('.mov');
            const fileName = path.basename(url);
            return `
            <div class="gallery-item" onclick="openFullscreen('${fileName}')">
                ${isVideo ? 
                    `<video src="${url}" controls></video>` : 
                    `<img src="${url}" alt="Image" />`
                }
                <div class="info">Size: ${size} bytes<br>Uploaded: ${dateStr}</div>
                <a href="${url}" download class="download-button">Download</a>
            </div>
            <div id="fullscreen-${fileName}" class="fullscreen">
                <span class="fullscreen-close" onclick="closeFullscreen()">×</span>
                ${isVideo ? 
                    `<video src="${url}" controls autoplay></video>` : 
                    `<img src="${url}" alt="Image" />`
                }
            </div>
            `;
        }).join('')}
    </div>
    <script>
        function openFullscreen(fileName) {
            document.getElementById('fullscreen-' + fileName).style.display = 'flex';
        }

        function closeFullscreen() {
            document.querySelectorAll('.fullscreen').forEach(element => {
                element.style.display = 'none';
            });
        }
    </script>
</body>
</html>
`;

// Route to handle local video streaming with range requests
app.get('/local/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(LOCAL_VIDEO_DIR, filename);
    
    fs.stat(filePath, (err, stats) => {
        if (err) {
            res.status(404).send('Not Found');
            return;
        }

        const fileSize = stats.size;
        const range = req.headers.range;
        
        if (range) {
            const [start, end] = range.replace(/bytes=/, "").split("-").map(Number);
            const chunkSize = (end - start) + 1;
            const fileStream = fs.createReadStream(filePath, { start, end });

            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": "video/mp4"
            });

            fileStream.pipe(res);
        } else {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": "video/mp4"
            });

            fs.createReadStream(filePath).pipe(res);
        }
    });
});

// Route to stream media files from SFTP
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
            res.writeHead(200, {
                "Content-Type": mime.lookup(filename) || "application/octet-stream",
                "Content-Length": sftpStream.length
            });
            stream.pipe(res);
        } else {
            res.status(404).send('Not Found');
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    } finally {
        if (sftp) {
            await sftp.end();
        }
    }
});

// Route to handle file uploads
app.post('/upload', ipRestrict, upload.single('video'), (req, res) => {
    res.send('File uploaded successfully.');
});

// Route to handle folder creation
app.post('/create-folder', folderManagementIpRestrict, (req, res) => {
    const { folderName } = req.body;
    const folderPath = path.join(LOCAL_VIDEO_DIR, folderName);
    
    if (!folderName) {
        return res.status(400).send('Folder name is required.');
    }

    fs.mkdir(folderPath, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error creating folder.');
        }
        res.send('Folder created successfully.');
    });
});

// Route to handle folder deletion
app.post('/delete-folder', folderManagementIpRestrict, (req, res) => {
    const { folderName } = req.body;
    const folderPath = path.join(LOCAL_VIDEO_DIR, folderName);
    
    if (!folderName) {
        return res.status(400).send('Folder name is required.');
    }

    fs.rmdir(folderPath, { recursive: true }, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error deleting folder.');
        }
        res.send('Folder deleted successfully.');
    });
});

// Route to display media gallery
app.get('/', async (req, res) => {
    const media = await listMedia();
    const clientIp = req.ip;
    const showFolderButtons = clientIp === ALLOWED_IP;
    res.send(galleryTemplate(media, showFolderButtons));
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
