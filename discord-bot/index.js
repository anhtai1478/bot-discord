require('dotenv').config({ path: require('path').join(__dirname, '.env') });
process.env.FFMPEG_PATH = require('ffmpeg-static');

// 1. HTTP Server giả lập giúp Render giữ service luôn Active
const http = require('http');
const server = http.createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end('Bot Discord đang chạy trực tuyến!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[HTTP] Server đang lắng nghe tại port ${PORT}`));

// Bắt lỗi toàn cục tránh crash bot
process.on('unhandledRejection', (error) => {
	console.error('Unhandled Promise Rejection:', error);
});
process.on('uncaughtException', (error) => {
	console.error('Uncaught Exception:', error);
});

const {
	Client,
	GatewayIntentBits,
	PermissionsBitField,
} = require('discord.js');
const {
	AudioPlayerStatus,
	NoSubscriberBehavior,
	StreamType,
	createAudioPlayer, // Đã bổ sung import bị thiếu ở đây
	createAudioResource,
	joinVoiceChannel,
	entersState,
	VoiceConnectionStatus,
} = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const scdl = require('soundcloud-downloader').default;

const PREFIX = 'b!';
const IDLE_TIMEOUT = 24 * 60 * 60 * 1000;
const queues = new Map();
const ALLOWED_SOUNDCLOUD_USERS = (process.env.ALLOWED_SOUNDCLOUD_USERS || 'your_soundcloud_username')
	.split(',')
	.map((value) => value.trim().toLowerCase())
	.filter(Boolean);

// Bot phải ở lại trong room cho đến khi người dùng chủ động ra lệnh rời.
// Do đó, không dùng logic tự động ngắt kết nối theo thời gian rảnh nữa.

function normalizeUrl(value) {
	try {
		const url = new URL(value);
		if (url.hostname === 'soundcloud.com' || url.hostname === 'm.soundcloud.com' || url.hostname.endsWith('.soundcloud.com')) {
			return url.toString();
		}
		return value;
	} catch {
		return value;
	}
}

function getSoundCloudUsernameFromUrl(value) {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		if (!(host === 'soundcloud.com' || host === 'm.soundcloud.com' || host.endsWith('.soundcloud.com'))) {
			return null;
		}
		const parts = url.pathname.split('/').filter(Boolean);
		return parts[0]?.toLowerCase() || null;
	} catch {
		return null;
	}
}

function isSupportedMusicUrl(value) {
	if (!value) return false;
	const url = normalizeUrl(value);
	try {
		const parsed = new URL(url);
		const isSoundCloud = parsed.hostname === 'soundcloud.com' || parsed.hostname === 'm.soundcloud.com' || parsed.hostname.endsWith('.soundcloud.com');
		if (!isSoundCloud) return false;
		const username = getSoundCloudUsernameFromUrl(parsed.toString());
		return username ? ALLOWED_SOUNDCLOUD_USERS.includes(username) : false;
	} catch {
		return false;
	}
}

async function createAudioStream(url) {
	if (/soundcloud\.com/i.test(url)) {
		return await scdl.download(url);
	}

	throw new Error('Chỉ hỗ trợ link SoundCloud từ tài khoản được phép.');
}

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
	],
});

function getQueue(guildId) {
	if (!queues.has(guildId)) {
		const player = createAudioPlayer({
			behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
		});
		const queue = { guildId, player, items: [], connection: null, current: null, idleTimer: null, stayInChannel: true };

		player.on(AudioPlayerStatus.Idle, () => playNext(queue));
		player.on('error', (error) => {
			console.error(`[${guildId}] Audio error:`, error.message);
			playNext(queue);
		});
		queues.set(guildId, queue);
	}
	return queues.get(guildId);
}

function scheduleIdleDisconnect(queue) {
	// Tắt hoàn toàn tự động rời kênh: bot chỉ rời khi có lệnh b!leave hoặc boot lại.
	if (queue.idleTimer) {
		clearTimeout(queue.idleTimer);
	}
	queue.idleTimer = null;
	return;
}

async function playNext(queue) {
	const item = queue.items.shift();

	if (!item) {
		queue.current = null;
		scheduleIdleDisconnect(queue);
		return;
	}

	queue.current = item;

	try {
		console.log('=================================');
		console.log('Đang lấy stream...');
		console.log('URL:', item.url);

		const stream = await createAudioStream(item.url);

		stream.on('error', (error) => queue.player.emit('error', error));

		console.log('Lấy stream thành công!');

		// Truyền thẳng biến stream vào createAudioResource
		const resource = createAudioResource(stream, {
			inputType: StreamType.Arbitrary,
			inlineVolume: true,
		});

		resource.volume.setVolume(0.5);

		queue.player.play(resource);

		await item.channel.send(`🎵 Đang phát: **${item.url}**`);

	} catch (error) {
		console.error('=================================');
		console.error('❌ LỖI PHÁT NHẠC');
		console.error('Message:', error.message);
		console.error('Stack:', error.stack);
		console.error('=================================');

		await item.channel.send(`❌ Không thể phát link này.\n\`\`\`\n${error.message}\n\`\`\``);

		queue.current = null;
		await playNext(queue);
	}
}

async function connectAndPlay(message, url) {
	const voiceChannel = message.member.voice.channel;
	if (!voiceChannel) {
		await message.reply('Bạn cần vào một kênh thoại trước khi dùng lệnh này.');
		return;
	}

	const permissions = voiceChannel.permissionsFor(message.client.user);
	if (!permissions?.has(PermissionsBitField.Flags.Connect) ||
		!permissions.has(PermissionsBitField.Flags.Speak)) {
		await message.reply('Bot cần quyền **Connect** và **Speak** trong kênh thoại này.');
		return;
	}

	const queue = getQueue(message.guildId);
	if (queue.idleTimer) {
		clearTimeout(queue.idleTimer);
		queue.idleTimer = null;
	}
	if (!queue.connection || queue.connection.joinConfig.channelId !== voiceChannel.id) {
		if (queue.connection) queue.connection.destroy();
		queue.connection = joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: message.guildId,
			adapterCreator: message.guild.voiceAdapterCreator,
			selfDeaf: true,
		});
		queue.connection.subscribe(queue.player);
		await entersState(queue.connection, VoiceConnectionStatus.Ready, 15_000);
	}

	queue.items.push({ url, channel: message.channel });
	if (queue.player.state.status === AudioPlayerStatus.Idle && !queue.current) {
		await playNext(queue);
	} else {
		await message.reply(`Đã thêm vào hàng đợi ở vị trí ${queue.items.length}.`);
	}
}

async function joinVoiceRoom(message) {
	const voiceChannel = message.member.voice.channel;
	if (!voiceChannel) {
		await message.reply('Bạn cần vào một kênh thoại trước khi gọi bot.');
		return;
	}

	const permissions = voiceChannel.permissionsFor(message.client.user);
	if (!permissions?.has(PermissionsBitField.Flags.Connect) ||
		!permissions.has(PermissionsBitField.Flags.Speak)) {
		await message.reply('Bot cần quyền **Connect** và **Speak** trong kênh thoại này.');
		return;
	}

	const queue = getQueue(message.guildId);
	if (queue.idleTimer) {
		clearTimeout(queue.idleTimer);
		queue.idleTimer = null;
	}
	if (!queue.connection || queue.connection.joinConfig.channelId !== voiceChannel.id) {
		queue.connection?.destroy();
		queue.connection = joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: message.guildId,
			adapterCreator: message.guild.voiceAdapterCreator,
			selfDeaf: true,
		});
		queue.connection.subscribe(queue.player);
		await entersState(queue.connection, VoiceConnectionStatus.Ready, 15_000);
	}

	await message.reply(`Bot đã vào phòng **${voiceChannel.name}** và sẽ ở lại.`);
}

client.once('clientReady', (readyClient) => {
	console.log(`Đã đăng nhập thành công với tên: ${readyClient.user.tag}`);
});

client.on('messageCreate', async (message) => {
	if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

	const [command, argument] = message.content.trim().split(/\s+/);
	try {
		if (command === 'b!zoo') {
			await joinVoiceRoom(message);
		} else if (command === 'b!p' || command === 'b!play') {
			const normalizedUrl = argument && normalizeUrl(argument);
			if (!normalizedUrl || !isSupportedMusicUrl(normalizedUrl)) {
				await message.reply(`Dùng: \`b!p <link SoundCloud của ${ALLOWED_SOUNDCLOUD_USERS.join(', ')} >\``);
				return;
			}
			await connectAndPlay(message, normalizedUrl);
		} else if (command === 'b!skip') {
			const queue = queues.get(message.guildId);
			if (!queue?.current) return message.reply('Hiện không có bài nào đang phát.');
			queue.player.stop();
			await message.reply('Đã chuyển bài.');
		} else if (command === 'b!stop') {
			const queue = queues.get(message.guildId);
			if (!queue) return message.reply('Bot chưa ở trong kênh thoại.');
			queue.items.length = 0;
			queue.current = null;
			queue.player.stop();
			await message.reply('Đã dừng nhạc. Bot vẫn ở trong phòng.');
		} else if (command === 'b!leave') {
			const queue = queues.get(message.guildId);
			if (!queue) return message.reply('Bot chưa ở trong kênh thoại.');
			if (queue.idleTimer) clearTimeout(queue.idleTimer);
			queue.idleTimer = null;
			queue.items.length = 0;
			queue.current = null;
			queue.player.stop();
			queue.connection?.destroy();
			queue.connection = null;
			await message.reply('Đã dừng nhạc và rời kênh thoại.');
		} else if (command === 'b!queue') {
			const queue = queues.get(message.guildId);
			if (!queue?.current && !queue?.items.length) return message.reply('Hàng đợi đang trống.');
			const list = queue.items.map((item, index) => `${index + 1}. ${item.url}`).join('\n');
			await message.reply(`Đang phát: ${queue.current?.url || 'Không có'}\n${list}`);
		}
	} catch (error) {
		console.error('Command error:', error);
		await message.reply('Có lỗi xảy ra khi xử lý lệnh.');
	}
});

if (!process.env.DISCORD_TOKEN) {
	throw new Error('Thiếu DISCORD_TOKEN trong file .env');
}

client.login(process.env.DISCORD_TOKEN);