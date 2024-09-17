require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const multer = require('multer');
const { createClient } = require('webdav');
const app = express();

// Middleware for handling file uploads (up to 700MB)
const upload = multer({ limits: { fileSize: 700 * 1024 * 1024 } });

// Restrict access to a specific IP
const allowedIP = process.env.UPLOAD_ALLOWED_IP; // Set this to your allowed IP
function ipRestrict(req, res, next) {
    if (req.ip !== allowedIP) {
        return res.status(403).send('Access denied.');
    }
    next();
}

// Serve static files from local media directory
app.use('/media', express.static(process.env.LOCAL_MEDIA_DIR));
app.use('/videos', express.static(process.env.LOCAL_VIDEO_DIR));

// Create Nextcloud WebDAV client
function createNextcloudClient() {
    return createClient(process.env.NEXTCLOUD_URL, {
        username: process.env.NEXTCLOUD_USER,
        password: process.env.NEXTCLOUD_PASSWORD
    });
}

// List local media files
function listLocalMedia() {
    const mediaItems = [];
    const files = fs.readdirSync(process.env.LOCAL_MEDIA_DIR);
    
    files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
            const stats = fs.statSync(path.join(process.env.LOCAL_MEDIA_DIR, file));
            const uploadDate = stats.mtime;
            const fileUrl = `/media/${encodeURIComponent(file)}`;

            mediaItems.push({
                url: fileUrl,
                size: stats.size,
                uploadDate: uploadDate instanceof Date ? uploadDate : 'Unknown Date'
            });
        }
    });
    
    return mediaItems;
}

// List Nextcloud media files
async function listNextcloudMedia() {
    const nextcloudClient = createNextcloudClient();
    const mediaItems = [];
    
    try {
        const nextcloudFileList = await nextcloudClient.getDirectoryContents(process.env.NEXTCLOUD_DIR);

        for (const file of nextcloudFileList) {
            const ext = path.extname(file.basename).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/nextcloud/${encodeURIComponent(file.basename)}`;
                const uploadDate = new Date(file.lastmod);

                mediaItems.push({
                    url: fileUrl,
                    size: file.size,
                    uploadDate: uploadDate instanceof Date ? uploadDate : 'Unknown Date'
                });
            }
        }

        return mediaItems;
    } catch (error) {
        console.error('Error listing Nextcloud media:', error);
        return [];
    }
}

// Serve media files from Nextcloud
app.get('/nextcloud/:filename', async (req, res) => {
    const { filename } = req.params;
    const nextcloudClient = createNextcloudClient();
    
    try {
        const remoteFilePath = path.join(process.env.NEXTCLOUD_DIR, filename);
        const fileStream = await nextcloudClient.createReadStream(remoteFilePath);

        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.setHeader('Content-Type', mime.lookup(filename) || 'application/octet-stream');
        fileStream.pipe(res);
    } catch (error) {
        console.error('Error serving Nextcloud file:', error);
        res.status(500).send('Error retrieving file.');
    }
});

// Combine media from all sources (Local, Nextcloud)
async function listMedia() {
    let localMedia = [], nextcloudMedia = [];
    
    // List files from Local and Nextcloud
    localMedia = listLocalMedia();
    nextcloudMedia = await listNextcloudMedia();

    // Combine media from all sources and sort by upload date
    const allMedia = [...localMedia, ...nextcloudMedia];
    allMedia.sort((a, b) => (a.uploadDate instanceof Date && b.uploadDate instanceof Date) ? b.uploadDate - a.uploadDate : 0);

    return allMedia;
}

// Gallery endpoint to show media list
app.get('/gallery', async (req, res) => {
    try {
        const mediaList = await listMedia();
        res.json(mediaList);
    } catch (error) {
        res.status(500).send('Error retrieving media list.');
    }
});

// Upload handler for Nextcloud
async function uploadToNextcloud(file) {
    const nextcloudClient = createNextcloudClient();
    const remoteFilePath = path.join(process.env.NEXTCLOUD_DIR, file.originalname);

    try {
        const fileBuffer = fs.readFileSync(file.path);
        await nextcloudClient.putFileContents(remoteFilePath, fileBuffer, { overwrite: true });
        console.log(`File uploaded to Nextcloud: ${remoteFilePath}`);
    } catch (error) {
        console.error('Error uploading to Nextcloud:', error);
    }
}

// File upload endpoint
app.post('/upload', ipRestrict, upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const filePath = path.join(process.env.LOCAL_VIDEO_DIR, req.file.filename);
    const fileBuffer = fs.readFileSync(filePath);
    const mimeType = mime.lookup(req.file.originalname) || 'video/mp4';
    const newFilePath = path.join(process.env.LOCAL_VIDEO_DIR, `${req.file.filename}.${mime.extension(mimeType) || 'mp4'}`);
    fs.renameSync(filePath, newFilePath);

    // Upload to Nextcloud (optional)
    await uploadToNextcloud(req.file);

    res.send('Upload successful.');
});

// Function to create a folder locally
function createLocalFolder(folderName) {
    const folderPath = path.join(process.env.LOCAL_MEDIA_DIR, folderName);
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        console.log(`Local folder created: ${folderPath}`);
    } else {
        console.log(`Local folder already exists: ${folderPath}`);
    }
}

// Function to create a folder on Nextcloud
async function createNextcloudFolder(folderName) {
    const nextcloudClient = createNextcloudClient();
    const remoteFolderPath = path.join(process.env.NEXTCLOUD_DIR, folderName);
    
    try {
        await nextcloudClient.createDirectory(remoteFolderPath);
        console.log(`Nextcloud folder created: ${remoteFolderPath}`);
    } catch (error) {
        console.error('Error creating Nextcloud folder:', error);
    }
}

// Endpoint to create a folder
app.post('/create-folder', ipRestrict, express.json(), async (req, res) => {
    const { folderName, storage } = req.body; // storage can be 'local' or 'nextcloud'
    
    if (!folderName || !storage) {
        return res.status(400).send('Folder name and storage type required.');
    }

    if (storage === 'local') {
        createLocalFolder(folderName);
        res.send('Local folder created.');
    } else if (storage === 'nextcloud') {
        await createNextcloudFolder(folderName);
        res.send('Nextcloud folder created.');
    } else {
        res.status(400).send('Invalid storage type.');
    }
});

// Start the server
app.listen(process.env.PORT || 3000, () => {
    console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
