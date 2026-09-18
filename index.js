'use strict';

//1
const { Client } = require('discord.js-selfbot-v13');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

//1b — load bundled binary paths (written by install-bins.js postinstall)
let FFMPEG_BIN = 'ffmpeg';
let YTDLP_BIN  = 'yt-dlp';
try {
    const bins = JSON.parse(fs.readFileSync(path.join(__dirname, 'bin-paths.json'), 'utf8'));
    if (bins.ffmpeg) FFMPEG_BIN = bins.ffmpeg;
    if (bins.ytdlp)  YTDLP_BIN  = bins.ytdlp;
} catch {
    // bin-paths.json not ready yet (first run before postinstall), use system paths
}

//2
const TOKEN_VC   = process.env.TOKEN_VC   || 'YOUR_VC_TOKEN_HERE';
const TOKEN_CTRL = process.env.TOKEN_CTRL || 'YOUR_CTRL_TOKEN_HERE';
const PREFIX     = '.';
const AUDIO_DIR  = path.join(__dirname, 'audio');

//3
const vc = {
    connection  : null,
    player      : null,
    guildId     : null,
    channelId   : null,
    looping     : false,
    paused      : false,
    currentIdx  : null,
    currentFile : null,
    currentTemp : null,
    seekSeconds : 0,
    startedAt   : null,
    volume      : 1.0,
    pan         : 0.0,
    panMode     : 'custom',
    bass        : 0,
    treble      : 0,
    reverbWet   : 0,
    reverbDelay : 60,
    reverbDecay : 0.4,
    threedOn    : false,
    queue       : [],
    ytProc      : null,
};

//4
const vcClient   = new Client({ checkUpdate: false });
const ctrlClient = new Client({ checkUpdate: false });
const sameToken  = TOKEN_VC === TOKEN_CTRL;

//5
const log  = m => console.log(`\x1b[35m[\x1b[0m${new Date().toTimeString().slice(0,8)}\x1b[35m]\x1b[0m ${m}`);
const box  = t => `\`\`\`\n${t}\n\`\`\``;
const edit = (msg, t) => msg.edit(box(t)).catch(() => {});

//6
function getAudioFiles() {
    try {
        return fs.readdirSync(AUDIO_DIR)
            .filter(f => /\.(mp3|ogg|wav|flac|m4a)$/i.test(f))
            .sort();
    } catch { return []; }
}

function findChannel(channelId) {
    for (const guild of vcClient.guilds.cache.values()) {
        const ch = guild.channels.cache.get(channelId);
        if (ch) return ch;
    }
    return null;
}

function elapsed() {
    if (!vc.startedAt) return vc.seekSeconds;
    if (vc.paused)     return vc.seekSeconds;
    return vc.seekSeconds + (Date.now() - vc.startedAt) / 1000;
}

function panLabel() {
    if (vc.panMode !== 'custom') return vc.panMode;
    if (vc.pan === 0) return 'center';
    return vc.pan > 0
        ? `right ${Math.round(vc.pan * 100)}%`
        : `left ${Math.round(Math.abs(vc.pan) * 100)}%`;
}

//7
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file  = fs.createWriteStream(dest);
        proto.get(url, res => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                fs.unlink(dest, () => {});
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                fs.unlink(dest, () => {});
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
        }).on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    });
}

//8b
function killYtProc() {
    if (vc.ytProc) {
        try { vc.ytProc.kill('SIGKILL'); } catch {}
        vc.ytProc = null;
    }
}

function buildURLChain() {
    const p = vc.pan;
    let panFilter;
    if (vc.panMode === 'inhead') {
        panFilter = 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1';
    } else if (vc.panMode === 'wide') {
        panFilter = 'pan=stereo|c0=1.2*c0-0.2*c1|c1=1.2*c1-0.2*c0';
    } else if (vc.panMode === 'upleft') {
        panFilter = 'pan=stereo|c0=1.0*c0|c1=0.0*c1,treble=g=4';
    } else if (vc.panMode === 'upright') {
        panFilter = 'pan=stereo|c0=0.0*c0|c1=1.0*c1,treble=g=4';
    } else if (vc.panMode === 'downleft') {
        panFilter = 'pan=stereo|c0=1.0*c0|c1=0.0*c1,bass=g=5';
    } else if (vc.panMode === 'downright') {
        panFilter = 'pan=stereo|c0=0.0*c0|c1=1.0*c1,bass=g=5';
    } else {
        const L = p <= 0 ? 1.0 : +(1.0 - p).toFixed(4);
        const R = p >= 0 ? 1.0 : +(1.0 + p).toFixed(4);
        panFilter = 'pan=stereo|c0=' + L + '*c0|c1=' + R + '*c1';
    }
    let chain = 'volume=' + vc.volume.toFixed(4) + ',' + panFilter;
    if (vc.bass   !== 0) chain += ',bass=g=' + vc.bass;
    if (vc.treble !== 0) chain += ',treble=g=' + vc.treble;
    if (vc.threedOn)     chain += ',apulsator=mode=sine:hz=0.1:width=1.0';
    if (vc.reverbWet > 0) {
        const wet   = Math.min(vc.reverbWet, 1.0).toFixed(4);
        const delay = Math.max(1, vc.reverbDelay);
        const decay = Math.max(0.01, vc.reverbDecay).toFixed(4);
        chain += ',aecho=0.8:' + wet + ':' + delay + ':' + decay;
    }
    return chain;
}

function streamFromURL(url) {
    killYtProc();

    const ytdlp = spawn(YTDLP_BIN, [
        '-f', 'bestaudio/best',
        '-o', '-',
        '--quiet',
        '--no-playlist',
        '--no-warnings',
        url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    vc.ytProc = ytdlp;

    const ffmpeg = spawn(FFMPEG_BIN, [
        '-i', 'pipe:0',
        '-filter_complex', '[0:a]' + buildURLChain() + '[out]',
        '-map', '[out]',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ytdlp.stderr.on('data', () => {});
    ytdlp.on('error', () => { try { ffmpeg.stdin.end(); } catch {} });
    ytdlp.on('close', () => { try { ffmpeg.stdin.end(); } catch {} });
    ffmpeg.on('error', () => {});
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stdout.on('error', () => {});

    return ffmpeg.stdout;
}

function getURLTitle(url) {
    return new Promise(resolve => {
        const proc = spawn(YTDLP_BIN, [
            '--get-title', '--no-playlist', '--quiet', '--no-warnings', url
        ]);
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('error', () => resolve(url));
        proc.on('close', () => resolve(out.trim() || url));
    });
}

//8
function buildStream(filePath, seekSec) {
    let panFilter;
    const p = vc.pan;

    if (vc.panMode === 'inhead') {
        panFilter = 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1';
    } else if (vc.panMode === 'wide') {
        panFilter = 'pan=stereo|c0=1.2*c0-0.2*c1|c1=1.2*c1-0.2*c0';
    } else if (vc.panMode === 'upleft') {
        panFilter = 'pan=stereo|c0=1.0*c0|c1=0.0*c1,treble=g=4';
    } else if (vc.panMode === 'upright') {
        panFilter = 'pan=stereo|c0=0.0*c0|c1=1.0*c1,treble=g=4';
    } else if (vc.panMode === 'downleft') {
        panFilter = 'pan=stereo|c0=1.0*c0|c1=0.0*c1,bass=g=5';
    } else if (vc.panMode === 'downright') {
        panFilter = 'pan=stereo|c0=0.0*c0|c1=1.0*c1,bass=g=5';
    } else {
        const L = p <= 0 ? 1.0 : +(1.0 - p).toFixed(4);
        const R = p >= 0 ? 1.0 : +(1.0 + p).toFixed(4);
        panFilter = `pan=stereo|c0=${L}*c0|c1=${R}*c1`;
    }

    let chain = `volume=${vc.volume.toFixed(4)},${panFilter}`;
    if (vc.threedOn) chain += ',apulsator=mode=sine:hz=0.1:width=1.0';
    if (vc.bass   !== 0) chain += `,bass=g=${vc.bass}`;
    if (vc.treble !== 0) chain += `,treble=g=${vc.treble}`;
    if (vc.reverbWet > 0) {
        const wet   = Math.min(vc.reverbWet, 1.0).toFixed(4);
        const delay = Math.max(1, vc.reverbDelay);
        const decay = Math.max(0.01, vc.reverbDecay).toFixed(4);
        chain += `,aecho=0.8:${wet}:${delay}:${decay}`;
    }

    const proc = spawn(FFMPEG_BIN, [
        '-ss', String(Math.max(0, seekSec ?? 0)),
        '-i', filePath,
        '-filter_complex', `[0:a]${chain}[out]`,
        '-map', '[out]',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    return proc.stdout;
}

//9
function playPath(filePath, seekSec, label) {
    vc.paused     = false;
    vc.seekSeconds = seekSec ?? 0;
    vc.startedAt  = Date.now();
    vc.player.play(createAudioResource(
        buildStream(filePath, vc.seekSeconds),
        { inputType: StreamType.Raw }
    ));
    log(`▶ ${label}  vol:${Math.round(vc.volume * 100)}%`);
}

function playFile(idx, seekSec) {
    const files = getAudioFiles();
    if (!files.length)             return 'no audio files in ./audio/';
    if (idx < 0 || idx >= files.length)
        return `track ${idx + 1} doesn't exist — ${files.length} loaded`;

    const fp = path.join(AUDIO_DIR, files[idx]);
    if (!fs.existsSync(fp))        return `file not found: ${files[idx]}`;

    if (vc.currentTemp) {
        try { fs.unlinkSync(vc.currentTemp); } catch {}
        vc.currentTemp = null;
    }

    vc.currentIdx  = idx;
    vc.currentFile = files[idx];
    playPath(fp, seekSec ?? 0, `[${idx + 1}] ${files[idx]}`);
    return null;
}

function replayWithFilters(keepPos) {
    if (vc.currentTemp) {
        const pos = keepPos ? elapsed() : 0;
        const was = vc.paused;
        playPath(vc.currentTemp, pos, vc.currentFile);
        if (was) setTimeout(() => { vc.player?.pause(); vc.paused = true; }, 150);
        return;
    }
    if (vc.currentIdx === null) return;
    const pos = keepPos ? elapsed() : 0;
    const was = vc.paused;
    playFile(vc.currentIdx, pos);
    if (was) setTimeout(() => { vc.player?.pause(); vc.paused = true; }, 150);
}

//10
function setupPlayer() {
    if (vc.player) { vc.player.removeAllListeners(); vc.player.stop(true); }
    vc.player = createAudioPlayer();

    vc.player.on(AudioPlayerStatus.Idle, () => {
        if (vc.currentTemp) {
            try { fs.unlinkSync(vc.currentTemp); } catch {}
            vc.currentTemp = null;
        }
        if (vc.queue.length > 0) {
            const next = vc.queue.shift();
            setTimeout(() => playFile(next, 0), 300);
            return;
        }
        if (vc.looping && vc.currentIdx !== null) {
            setTimeout(() => playFile(vc.currentIdx, 0), 300);
        }
    });

    vc.player.on('error', e => log(`[player] ${e.message}`));
    if (vc.connection) vc.connection.subscribe(vc.player);
}

function destroyVC() {
    vc.looping = vc.paused = false;
    vc.currentIdx = vc.currentFile = null;
    if (vc.currentTemp) { try { fs.unlinkSync(vc.currentTemp); } catch {} vc.currentTemp = null; }
    vc.seekSeconds = 0; vc.startedAt = null;
    vc.volume = 1.0; vc.pan = 0.0; vc.panMode = 'custom'; vc.threedOn = false;
    vc.bass = 0; vc.treble = 0; vc.reverbWet = 0;
    vc.queue = [];
    killYtProc();
    vc.player?.stop(true);    vc.player     = null;
    vc.connection?.destroy(); vc.connection = null;
    vc.guildId = vc.channelId = null;
}

//11
async function handleCommand(msg, raw) {
    const parts = raw.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();
    const args  = parts.slice(1);

    if (cmd === 'menu') {
        const files    = getAudioFiles();
        const vcLine   = vc.connection ? `connected · ch:${vc.channelId}` : 'not connected';
        const nowPlaying = vc.currentFile
            ? `${vc.paused ? '⏸' : '▶'} [${(vc.currentIdx ?? 0) + 1}] ${vc.currentFile}`.slice(0, 38)
            : 'nothing playing';
        const qLine    = vc.queue.length ? `${vc.queue.length} track(s) queued` : 'empty';
        const w        = 40;
        const top      = `╭${'─'.repeat(w)}╮`;
        const bot      = `╰${'─'.repeat(w)}╯`;
        const mid      = `├${'─'.repeat(w)}┤`;
        const ln  = s  => `│ ${s.padEnd(w - 1)}│`;
        const hd  = s  => `│ ${s.toUpperCase().padEnd(w - 1)}│`;
        const bl       = ln('');
        const kv  = (k, v) => ln(`${k.padEnd(10)}${v}`.slice(0, w - 1));

        const menu1 = [
            top,
            ln('  made by niylin'),
            mid,
            hd('join / leave'),
            bl,
            ln('  .jvc <channelId>'),
            ln('  .jvc <guildId> <channelId>'),
            ln('  .lvc'),
            mid,
            hd('playback'),
            bl,
            ln('  .tracks              list tracks'),
            ln('  .play <n>            play track n'),
            ln('  .play <url>           stream youtube / soundcloud'),
            ln('  .play  (reply file)  play attachment'),
            ln('  .restart             back to start'),
            ln('  .next  /  .prev      skip tracks'),
            ln('  .pause  /  .cont     pause / resume'),
            ln('  .stop                stop playback'),
            ln('  .loop                toggle loop'),
            ln('  .queue <n> [n]       queue tracks'),
            ln('  .queue clear         clear queue'),
            mid,
            hd('volume  (uncapped)'),
            bl,
            ln('  .vol <n>             set to n%'),
            ln('  .vol +10 / .vol -10  adjust'),
            bot,
        ].join('\n');

        const menu2 = [
            top,
            hd('pan modes'),
            bl,
            ln('  .pan <-100…100>      L/R pan'),
            ln('  .pan inhead          inside skull'),
            ln('  .pan wide            expanded stereo'),
            ln('  .pan upleft          upper-left'),
            ln('  .pan upright         upper-right'),
            ln('  .pan downleft        lower-left'),
            ln('  .pan downright       lower-right'),
            mid,
            hd('eq / fx'),
            bl,
            ln('  .bass <n>            boost/cut bass dB'),
            ln('  .treble <n>          boost/cut highs dB'),
            ln('  .reverb <wet> [ms] [decay]'),
            ln('  .reverb off'),
            ln('  .3d                   toggle 3D rotating audio'),
            ln('  .clearfx              reset all effects'),
            ln('  .play <url>           play youtube / soundcloud'),
            mid,
            hd('status'),
            bl,
            kv('vc',      vcLine),
            kv('now',     nowPlaying),
            kv('loop',    vc.looping ? 'on' : 'off'),
            kv('queue',   qLine),
            kv('vol',     Math.round(vc.volume * 100) + '%'),
            kv('pan',     panLabel()),
            kv('bass',    vc.bass + ' dB'),
            kv('treble',  vc.treble + ' dB'),
            kv('reverb',  vc.reverbWet > 0 ? `wet:${vc.reverbWet} ${vc.reverbDelay}ms` : 'off'),
            kv('files',   String(files.length)),
            bot,
        ].join('\n');

        await edit(msg, menu1);
        await msg.channel.send(box(menu2)).catch(() => {});
        return;
    }

    if (cmd === 'tracks') {
        const files = getAudioFiles();
        if (!files.length) { await edit(msg, 'no files in ./audio/'); return; }
        const list = files.map((f, i) => {
            const icon = vc.currentIdx === i ? (vc.paused ? '⏸' : '▶') : ' ';
            const inQ  = vc.queue.includes(i) ? ' [Q]' : '';
            return `${icon} ${String(i + 1).padStart(2)}.  ${f}${inQ}`;
        }).join('\n');
        await edit(msg, `tracks (${files.length})\n\n${list}`);
        return;
    }

    if (cmd === 'jvc') {
        let gId, chId;
        if (args.length === 2) {
            gId = args[0]; chId = args[1];
        } else if (args.length === 1) {
            const ch = findChannel(args[0]);
            if (!ch) { await edit(msg, `channel ${args[0]} not found`); return; }
            gId = ch.guild.id; chId = ch.id;
        } else {
            await edit(msg, '.jvc <channelId>\n.jvc <guildId> <channelId>');
            return;
        }

        const guild   = vcClient.guilds.cache.get(gId);
        if (!guild)   { await edit(msg, `guild ${gId} not cached`); return; }
        const channel = guild.channels.cache.get(chId);
        if (!channel) { await edit(msg, 'channel not found'); return; }

        if (vc.connection) destroyVC();

        try {
            vc.connection = joinVoiceChannel({
                channelId      : channel.id,
                guildId        : guild.id,
                adapterCreator : guild.voiceAdapterCreator,
                selfDeaf       : false,
                selfMute       : false,
            });
            vc.guildId   = guild.id;
            vc.channelId = channel.id;

            await entersState(vc.connection, VoiceConnectionStatus.Ready, 30_000);
            setupPlayer();

            vc.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        entersState(vc.connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(vc.connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                } catch {
                    log('[vc] disconnected — attempting rejoin');
                    const gSave = vc.guildId, cSave = vc.channelId;
                    const iSave = vc.currentIdx, posSave = elapsed();
                    destroyVC();
                    try {
                        const g2 = vcClient.guilds.cache.get(gSave);
                        const c2 = g2?.channels.cache.get(cSave);
                        if (!g2 || !c2) return;
                        vc.connection = joinVoiceChannel({
                            channelId: c2.id, guildId: g2.id,
                            adapterCreator: g2.voiceAdapterCreator,
                            selfDeaf: false, selfMute: false,
                        });
                        vc.guildId = gSave; vc.channelId = cSave;
                        await entersState(vc.connection, VoiceConnectionStatus.Ready, 15_000);
                        setupPlayer();
                        if (iSave !== null) playFile(iSave, posSave);
                        log('[vc] rejoined successfully');
                    } catch (e) { log(`[vc] rejoin failed: ${e.message}`); }
                }
            });

            log(`[vc] joined "${channel.name}" in "${guild.name}"`);
            await edit(msg, `joined  ${channel.name}  ·  ${guild.name}`);
        } catch (e) {
            destroyVC();
            await edit(msg, `failed to join: ${e.message}`);
        }
        return;
    }

    if (cmd === 'lvc') {
        if (!vc.connection) { await edit(msg, 'not in vc'); return; }
        destroyVC();
        await edit(msg, 'left vc');
        return;
    }

    if (cmd === 'play') {
        if (!vc.connection) { await edit(msg, 'join a vc first  (.jvc)'); return; }

        const arg = args[0];

        // url detected — youtube or soundcloud
        if (arg && /^https?:\/\//.test(arg)) {
            await edit(msg, 'fetching  ...');
            try {
                killYtProc();
                const title  = await getURLTitle(arg);
                const stream = streamFromURL(arg);

                vc.currentIdx  = null;
                vc.currentFile = title.slice(0, 60);
                vc.currentTemp = null;
                vc.seekSeconds = 0;
                vc.startedAt   = Date.now();
                vc.paused      = false;

                vc.player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
                log('▶ [url] ' + title);
                await edit(msg, '▶  ' + vc.currentFile + '\nvol: ' + Math.round(vc.volume*100) + '%  pan: ' + panLabel());
            } catch (e) {
                await edit(msg, 'failed: ' + e.message);
            }
            return;
        }

        // number — play from ./audio/
        const n = parseInt(arg, 10);
        if (!isNaN(n) && n >= 1) {
            const err = playFile(n - 1, 0);
            if (err) { await edit(msg, err); return; }
            await edit(msg, '▶  [' + n + ']  ' + vc.currentFile + (vc.looping ? '  ↺' : '') + '\nvol: ' + Math.round(vc.volume*100) + '%  pan: ' + panLabel());
            return;
        }

        await edit(msg, '.play <n>          play track by number\n.play <url>        youtube or soundcloud');
        return;
    }

    if (cmd === 'restart') {
        if (!vc.currentFile) { await edit(msg, 'nothing playing'); return; }
        if (vc.currentTemp) { playPath(vc.currentTemp, 0, vc.currentFile); }
        else if (vc.currentIdx !== null) { playFile(vc.currentIdx, 0); }
        await edit(msg, `↩  restarted  —  ${vc.currentFile}`);
        return;
    }

    if (cmd === 'next') {
        if (!vc.connection) { await edit(msg, 'not in vc'); return; }
        const files = getAudioFiles();
        if (!files.length)  { await edit(msg, 'no tracks loaded'); return; }
        const n = vc.currentIdx === null ? 0 : (vc.currentIdx + 1) % files.length;
        const err = playFile(n, 0);
        if (err) { await edit(msg, err); return; }
        await edit(msg, `⏭  [${n + 1}]  ${vc.currentFile}`);
        return;
    }

    if (cmd === 'prev') {
        if (!vc.connection) { await edit(msg, 'not in vc'); return; }
        const files = getAudioFiles();
        if (!files.length)  { await edit(msg, 'no tracks loaded'); return; }
        const n = vc.currentIdx === null ? 0 : (vc.currentIdx - 1 + files.length) % files.length;
        const err = playFile(n, 0);
        if (err) { await edit(msg, err); return; }
        await edit(msg, `⏮  [${n + 1}]  ${vc.currentFile}`);
        return;
    }

    if (cmd === 'queue') {
        if (!args.length) {
            if (!vc.queue.length) { await edit(msg, 'queue is empty'); return; }
            const files = getAudioFiles();
            const list  = vc.queue.map((i, p) => `  ${p + 1}. [${i + 1}] ${files[i] ?? '?'}`).join('\n');
            await edit(msg, `queue (${vc.queue.length})\n\n${list}`);
            return;
        }
        if (args[0].toLowerCase() === 'clear') { vc.queue = []; await edit(msg, 'queue cleared'); return; }
        const files = getAudioFiles();
        const added = [], invalid = [];
        for (const a of args) {
            const n = parseInt(a, 10);
            if (isNaN(n) || n < 1 || n > files.length) { invalid.push(a); continue; }
            vc.queue.push(n - 1);
            added.push(`[${n}] ${files[n - 1]}`);
        }
        let out = added.length ? `queued:\n${added.map(x => '  + ' + x).join('\n')}` : '';
        if (invalid.length) out += `\ninvalid: ${invalid.join(', ')}`;
        await edit(msg, out || 'nothing added');
        return;
    }

    if (cmd === 'pause') {
        if (!vc.player || vc.player.state.status === AudioPlayerStatus.Idle) { await edit(msg, 'nothing playing'); return; }
        if (vc.paused) { await edit(msg, 'already paused'); return; }
        vc.seekSeconds = elapsed();
        vc.player.pause();
        vc.paused = true;
        await edit(msg, `⏸  ${vc.currentFile ?? ''}`);
        return;
    }

    if (cmd === 'cont') {
        if (!vc.player)  { await edit(msg, 'nothing loaded'); return; }
        if (!vc.paused)  { await edit(msg, 'not paused'); return; }
        vc.player.unpause();
        vc.startedAt = Date.now();
        vc.paused    = false;
        await edit(msg, `▶  ${vc.currentFile ?? ''}`);
        return;
    }

    if (cmd === 'loop') {
        vc.looping = !vc.looping;
        await edit(msg, `loop  ${vc.looping ? '↺ on' : 'off'}`);
        return;
    }

    if (cmd === 'stop') {
        if (!vc.player) { await edit(msg, 'nothing playing'); return; }
        vc.looping = vc.paused = false;
        vc.player.stop(true);
        vc.currentIdx = vc.currentFile = null;
        vc.seekSeconds = 0; vc.startedAt = null;
        vc.queue = [];
        if (vc.currentTemp) { try { fs.unlinkSync(vc.currentTemp); } catch {} vc.currentTemp = null; }
        await edit(msg, 'stopped');
        return;
    }

    if (cmd === 'vol') {
        if (!args[0]) { await edit(msg, `vol: ${Math.round(vc.volume*100)}%\n.vol <n>  .vol +10  .vol -10`); return; }
        const r = args[0];
        let next;
        if      (r.startsWith('+')) next = vc.volume + parseInt(r.slice(1), 10) / 100;
        else if (r.startsWith('-')) next = vc.volume - parseInt(r.slice(1), 10) / 100;
        else                        next = parseInt(r, 10) / 100;
        if (isNaN(next) || next < 0) { await edit(msg, 'invalid'); return; }
        vc.volume = next;
        if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
        await edit(msg, `vol  →  ${Math.round(vc.volume * 100)}%`);
        return;
    }

    if (cmd === 'pan') {
        if (!args[0]) { await edit(msg, `pan: ${panLabel()}\n.pan <-100…100>  or a mode name`); return; }
        const modes = ['inhead','wide','upleft','upright','downleft','downright'];
        const mode  = args[0].toLowerCase();
        if (modes.includes(mode)) {
            vc.panMode = mode;
            if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
            await edit(msg, `pan  →  ${mode}`);
            return;
        }
        const val = parseInt(args[0], 10);
        if (isNaN(val) || val < -100 || val > 100) { await edit(msg, 'invalid — .pan <-100…100>'); return; }
        vc.pan = val / 100; vc.panMode = 'custom';
        if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
        await edit(msg, `pan  →  ${val === 0 ? 'center' : val > 0 ? `right ${val}%` : `left ${Math.abs(val)}%`}`);
        return;
    }

    if (cmd === 'bass') {
        const n = parseFloat(args[0]);
        if (isNaN(n)) { await edit(msg, `bass: ${vc.bass} dB\n.bass <n>`); return; }
        vc.bass = n;
        if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
        await edit(msg, `bass  →  ${n} dB`);
        return;
    }

    if (cmd === 'treble') {
        const n = parseFloat(args[0]);
        if (isNaN(n)) { await edit(msg, `treble: ${vc.treble} dB\n.treble <n>`); return; }
        vc.treble = n;
        if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
        await edit(msg, `treble  →  ${n} dB`);
        return;
    }

    if (cmd === 'reverb') {
        if (!args[0] || args[0].toLowerCase() === 'off') {
            vc.reverbWet = 0;
            if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
            await edit(msg, 'reverb  →  off');
            return;
        }
        const wet   = parseFloat(args[0]);
        const delay = args[1] ? parseFloat(args[1]) : vc.reverbDelay;
        const decay = args[2] ? parseFloat(args[2]) : vc.reverbDecay;
        if (isNaN(wet) || wet < 0) { await edit(msg, `.reverb <wet> [ms] [decay]\n.reverb off`); return; }
        vc.reverbWet   = wet;
        vc.reverbDelay = isNaN(delay) ? vc.reverbDelay : Math.max(1, delay);
        vc.reverbDecay = isNaN(decay) ? vc.reverbDecay : Math.max(0.01, decay);
        if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
        await edit(msg, `reverb  →  wet:${vc.reverbWet}  ${vc.reverbDelay}ms  decay:${vc.reverbDecay}`);
        return;
    }

    if (cmd === 'yt') {
        await edit(msg, '.yt is now merged into .play\njust do .play <url>');
        return;
    }

    if (cmd === '3d') {
        vc.threedOn = !vc.threedOn;
        if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
        await edit(msg, '3d  ' + (vc.threedOn ? 'on  —  audio rotates L→R' : 'off'));
        return;
    }

    if (cmd === 'clearfx') {
        vc.volume     = 1.0;
        vc.pan        = 0.0;
        vc.panMode    = 'custom';
        vc.bass       = 0;
        vc.treble     = 0;
        vc.reverbWet  = 0;
        vc.threedOn   = false;
        if (vc.player?.state.status === AudioPlayerStatus.Playing || vc.paused) replayWithFilters(true);
        await edit(msg, 'all fx cleared\nvol: 100%  pan: center  bass: 0  treble: 0  reverb: off  3d: off');
        return;
    }

}

//12
function attachListener(instance) {
    instance.on('messageCreate', async msg => {
        if (msg.author?.id !== instance.user?.id) return;
        if (!msg.content?.startsWith(PREFIX)) return;
        const raw = msg.content.slice(PREFIX.length).trim();
        if (!raw) return;
        handleCommand(msg, raw).catch(e => log('[cmd] ' + e.message));
    });
    instance.on('error', () => {});
}

//13
vcClient.on('ready', () => {
    log(`vc ready  —  ${vcClient.user.tag}`);
    if (!fs.existsSync(AUDIO_DIR)) {
        fs.mkdirSync(AUDIO_DIR);
        log('created ./audio/');
    } else {
        log(`${getAudioFiles().length} track(s) in ./audio/`);
    }
});

attachListener(vcClient);

if (sameToken) {
    vcClient.login(TOKEN_VC);
} else {
    ctrlClient.on('ready', () => log(`ctrl ready  —  ${ctrlClient.user.tag}`));
    attachListener(ctrlClient);
    vcClient.login(TOKEN_VC);
    ctrlClient.login(TOKEN_CTRL);
}