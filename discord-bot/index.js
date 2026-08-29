require('dotenv').config({ path: require('path').join(__dirname, '.env') });
process.env.FFMPEG_PATH = require('ffmpeg-static');

const http = require('http');
const { Readable } = require('stream');
const googleTTS = require('google-tts-api');

const httpServer = http.createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end('Bot Discord online 24/7.');
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
	console.log(`[HTTP] Bot đang nghe trên cổng ${PORT}`);
});

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
	createAudioPlayer,
	createAudioResource,
	joinVoiceChannel,
	entersState,
	VoiceConnectionStatus,
	NoSubscriberBehavior,
} = require('@discordjs/voice');

const PREFIX = 'b!';
const guildSessions = new Map();

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
	],
});

function getVoiceConnection(guild, voiceChannel) {
	return joinVoiceChannel({
		channelId: voiceChannel.id,
		guildId: guild.id,
		adapterCreator: guild.voiceAdapterCreator,
		selfDeaf: true,
	});
}

async function joinVoiceRoom(message) {
	const voiceChannel = message.member?.voice?.channel;
	if (!voiceChannel) {
		await message.reply('Bạn cần vào một kênh thoại trước khi gọi bot.');
		return null;
	}

	const permissions = voiceChannel.permissionsFor(message.client.user);
	if (!permissions?.has(PermissionsBitField.Flags.Connect) ||
		!permissions.has(PermissionsBitField.Flags.Speak)) {
		await message.reply('Bot cần quyền Connect và Speak trong kênh thoại này.');
		return null;
	}

	let session = guildSessions.get(message.guildId);
	if (session && session.connection.joinConfig.channelId !== voiceChannel.id) {
		session.connection.destroy();
		session = null;
	}

	if (!session) {
		const player = createAudioPlayer({
			behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
		});
		const connection = getVoiceConnection(message.guild, voiceChannel);
		connection.subscribe(player);
		await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
		const newSession = { connection, player };
		guildSessions.set(message.guildId, newSession);
		await message.reply(`Bot đã vào phòng **${voiceChannel.name}**.`);
		return newSession;
	}

	await message.reply(`Bot đang ở trong phòng **${voiceChannel.name}**.`);
	return session;
}

async function leaveVoiceRoom(message) {
	const session = guildSessions.get(message.guildId);
	if (!session) {
		await message.reply('Bot chưa ở trong kênh thoại nào.');
		return;
	}

	session.player.stop();
	session.connection.destroy();
	guildSessions.delete(message.guildId);
	await message.reply('Đã rời khỏi kênh thoại.');
}

async function sayTextInVoice(message, text) {
	const voiceChannel = message.member?.voice?.channel;
	if (!voiceChannel) {
		await message.reply('Bạn cần vào một kênh thoại trước khi dùng lệnh này.');
		return;
	}

	const permissions = voiceChannel.permissionsFor(message.client.user);
	if (!permissions?.has(PermissionsBitField.Flags.Connect) ||
		!permissions.has(PermissionsBitField.Flags.Speak)) {
		await message.reply('Bot cần quyền Connect và Speak trong kênh thoại này.');
		return;
	}

	let session = guildSessions.get(message.guildId);
	if (!session || session.connection.joinConfig.channelId !== voiceChannel.id) {
		const joined = await joinVoiceRoom(message);
		if (!joined) return;
		session = joined;
	}

	const audioUrl = googleTTS.getAudioUrl(text, {
		lang: 'vi',
		host: 'https://translate.google.com',
	});

	try {
		const response = await fetch(audioUrl);
		if (!response.ok) {
			throw new Error(`Google TTS request failed: ${response.status}`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const stream = Readable.from(buffer);
		const resource = createAudioResource(stream, {
			inputType: 'unknown',
		});

		session.player.play(resource);
		await message.reply(`Đang đọc: **${text}**`);

		await new Promise((resolve, reject) => {
			session.player.once('idle', resolve);
			session.player.once('error', reject);
		});
	} catch (error) {
		console.error('TTS error:', error);
		await message.reply('Không thể đọc giọng Google lúc này.');
	}
}

client.once('ready', (readyClient) => {
	console.log(`Bot online: ${readyClient.user.tag}`);
});

client.on('messageCreate', async (message) => {
	if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

	const [command, ...args] = message.content.trim().split(/\s+/);
	const text = args.join(' ');

	try {
		if (command === 'b!join') {
			await joinVoiceRoom(message);
		} else if (command === 'b!leave') {
			await leaveVoiceRoom(message);
		} else if (command === 'b!say') {
			if (!text) {
				await message.reply('Dùng: `b!say Xin chào`');
				return;
			}
			await sayTextInVoice(message, text);
		} else if (command === 'b!help') {
			await message.reply('Lệnh có sẵn:\n`b!join` - gọi bot vào phòng\n`b!say <nội dung>` - bot đọc văn bản bằng giọng Google\n`b!leave` - bot rời phòng');
		}
	} catch (error) {
		console.error('Command error:', error);
		await message.reply('Có lỗi khi xử lý lệnh.');
	}
});

if (!process.env.DISCORD_TOKEN) {
	throw new Error('Thiếu DISCORD_TOKEN trong file .env');
}

client.login(process.env.DISCORD_TOKEN);