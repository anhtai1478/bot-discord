require('dotenv').config({ path: require('path').join(__dirname, '.env') });

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
const play = require('play-dl');

const PREFIX = 'b!';
const queues = new Map();

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
		if (queue.connection) queue.connection.destroy();
		queue.connection = null;
		return;
	}

	queue.current = item;
	try {
		const stream = await play.stream(item.url, {
			quality: 2,
			discordPlayerCompatibility: true,
		});
		const resource = createAudioResource(stream.stream, {
			inputType: stream.type === 'opus' ? StreamType.WebmOpus : StreamType.Arbitrary,
			inlineVolume: true,
		});
		resource.volume.setVolume(0.5);
		queue.player.play(resource);
		await item.channel.send(`Đang phát: **${item.url}**`);
	} catch (error) {
		console.error('Không thể phát link:', error.message);
		await item.channel.send('Không thể phát link này. Hãy thử một URL YouTube hợp lệ.');
		playNext(queue);
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

client.once('clientReady', (readyClient) => {
	console.log(`Đã đăng nhập với tên ${readyClient.user.tag}`);
});

client.on('messageCreate', async (message) => {
	if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

	const [command, argument] = message.content.trim().split(/\s+/);
	try {
		if (command === 'b!p' || command === 'b!play') {
			if (!argument || !(await play.validate(argument))) {
				await message.reply('Dùng: `b! <link YouTube hoặc SoundCloud>`');
				return;
			}
			await connectAndPlay(message, argument);
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
