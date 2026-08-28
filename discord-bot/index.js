require('dotenv').config({ path: require('path').join(__dirname, '.env') });
process.env.FFMPEG_PATH = require('ffmpeg-static');

const {
	Client,
	GatewayIntentBits,
	PermissionsBitField,
} = require('discord.js');
const {
	AudioPlayerStatus,
	NoSubscriberBehavior,
	StreamType,
	createAudioPlayer,
	createAudioResource,
	joinVoiceChannel,
	entersState,
	VoiceConnectionStatus,
} = require('@discordjs/voice');
const ytdlp = require('youtube-dl-exec');

const PREFIX = 'b!';
const queues = new Map();

function normalizeUrl(value) {
	try {
		const url = new URL(value);
		if (url.hostname === 'youtu.be') {
			return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
		}
		if (url.hostname.endsWith('youtube.com')) {
			const videoId = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts\/|embed\/)?([^/?]+)/)?.[1];
			if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
		}
		return value;
	} catch {
		return value;
	}
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
		const queue = { guildId, player, items: [], connection: null, current: null };

		player.on(AudioPlayerStatus.Idle, () => playNext(queue));
		player.on('error', (error) => {
			console.error(`[${guildId}] Audio error:`, error.message);
			playNext(queue);
		});
		queues.set(guildId, queue);
	}
	return queues.get(guildId);
}

async function playNext(queue) {
	const item = queue.items.shift();

	if (!item) {
		queue.current = null;
		return;
	}

	queue.current = item;

	try {
		console.log('=================================');
		console.log('Đang lấy stream...');
		console.log('URL:', item.url);

		const stream = ytdlp.exec(item.url, {
			output: '-',
			format: 'bestaudio[ext=webm]/bestaudio',
			noPlaylist: true,
			quiet: true,
		}, { stdio: ['ignore', 'pipe', 'pipe'] });
		stream.stderr.on('data', (data) => console.error(`yt-dlp: ${data}`));
		stream.on('error', (error) => queue.player.emit('error', error));

		console.log('Lấy stream thành công!');

		const resource = createAudioResource(stream.stdout, {
			inputType: StreamType.Arbitrary,
			inlineVolume: true,
		});

		resource.volume.setVolume(0.5);

		queue.player.play(resource);

		await item.channel.send(
			`🎵 Đang phát: **${item.url}**`
		);

	} catch (error) {

		console.error('=================================');
		console.error('❌ LỖI PHÁT NHẠC');
		console.error('Message:', error.message);
		console.error('Name:', error.name);
		console.error('Stack:', error.stack);
		console.error('URL:', item.url);
		console.error('=================================');

		await item.channel.send(
			`❌ Không thể phát link này.\n\`\`\`\n${error.message}\n\`\`\``
		);

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
	console.log(`Đã đăng nhập với tên ${readyClient.user.tag}`);
});

client.on('messageCreate', async (message) => {
	if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

	const [command, argument] = message.content.trim().split(/\s+/);
	try {
		if (command === 'b!zoo') {
			await joinVoiceRoom(message);
		} else if (command === 'b!p' || command === 'b!play') {
			const normalizedUrl = argument && normalizeUrl(argument);
			if (!normalizedUrl || !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(normalizedUrl)) {
				await message.reply('Dùng: `b!p <link YouTube>`');
				return;
			}
			await connectAndPlay(message, normalizedUrl);
		} else if (command === 'b!skip') {
			const queue = queues.get(message.guildId);
			if (!queue?.current) return message.reply('Hiện không có bài nào đang phát.');
			queue.player.stop();
			await message.reply('Đã chuyển bài.');
		} else if (command === 'b!stop' || command === 'b!leave') {
			const queue = queues.get(message.guildId);
			if (!queue) return message.reply('Bot chưa ở trong kênh thoại.');
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