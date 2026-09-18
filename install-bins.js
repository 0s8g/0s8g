// Runs after npm install via "postinstall" script.
// Writes bin-paths.json so index.js knows where ffmpeg and yt-dlp are.

const fs   = require('fs');
const path = require('path');

const paths = {};

// ffmpeg-static ships a real ffmpeg binary — no Python needed
try {
    paths.ffmpeg = require('ffmpeg-static');
    console.log('[bins] ffmpeg:', paths.ffmpeg);
} catch {
    paths.ffmpeg = 'ffmpeg';
    console.log('[bins] ffmpeg-static not found, falling back to system ffmpeg');
}

// youtube-dl-exec ships yt-dlp as a standalone binary — no Python needed
try {
    const { YtDlp } = require('youtube-dl-exec');
    const ydl = new YtDlp();
    paths.ytdlp = ydl.binaryPath;
    console.log('[bins] yt-dlp:', paths.ytdlp);
} catch {
    // fallback: find the binary manually inside youtube-dl-exec
    try {
        const pkgDir = path.dirname(require.resolve('youtube-dl-exec/package.json'));
        const binDir = path.join(pkgDir, 'bin');
        const bins   = fs.readdirSync(binDir);
        const match  = bins.find(b => b.includes('yt-dlp'));
        paths.ytdlp  = match ? path.join(binDir, match) : 'yt-dlp';
        console.log('[bins] yt-dlp (fallback):', paths.ytdlp);
    } catch {
        paths.ytdlp = 'yt-dlp';
        console.log('[bins] yt-dlp: using system path');
    }
}

fs.writeFileSync(
    path.join(__dirname, 'bin-paths.json'),
    JSON.stringify(paths, null, 2)
);
console.log('[bins] bin-paths.json written ✓');
