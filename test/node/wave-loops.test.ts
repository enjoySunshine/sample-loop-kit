import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	InputAudioTrack,
	Output,
	SampleLoop,
	WavOutputFormat,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';

// Writes a mono 48 kHz pcm-s16 WAVE file: 5 packets of 960 bytes (480 samples = 10 ms) each, with the first
// byte of packet i set to 10 + i. Optionally writes the given sample loops into the 'smpl' chunk.
const writeMonoWav = async (loops?: SampleLoop[]) => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	if (loops) {
		output.setMetadataTags({ loops });
	}

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	for (let i = 0; i < 5; i++) {
		const data = new Uint8Array(960);
		data[0] = 10 + i;

		await source.add(
			new EncodedPacket(data, 'key', i * 0.01, 0.01),
			i === 0
				? { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48000 } }
				: undefined,
		);
	}

	await output.finalize();

	return output.target.buffer!;
};

const readWav = async (buffer: ArrayBuffer) => {
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	return { tags, track, packets };
};

// The 4800 bytes (2400 samples) get repacketized by the demuxer into two packets of 2048 and 352 frames
const expectMonoAudioSegments = async (
	track: InputAudioTrack,
	packets: EncodedPacket[],
) => {
	expect(await track.getSampleRate()).toBe(48000);
	expect(await track.getNumberOfChannels()).toBe(1);
	expect(await track.getDurationFromMetadata()).toBe(0.05); // 2400 samples in total

	expect(packets).toHaveLength(2);

	expect(packets[0]!.byteLength).toBe(4096);
	expect(packets[0]!.timestamp).toBe(0);
	expect(packets[0]!.duration).toBe(0.042666666666666665);
	expect(packets[0]!.data[0]).toBe(10);

	expect(packets[1]!.byteLength).toBe(704);
	expect(packets[1]!.timestamp).toBe(0.042666666666666665);
	expect(packets[1]!.duration).toBe(0.007333333333333333);
	expect(packets[1]!.data[0]).toBe(0);

	expect(packets[1]!.timestamp + packets[1]!.duration).toBeCloseTo(0.05, 10);
};

test('WAVE file with a sample loop', async () => {
	const buffer = await writeMonoWav([{ start: 480, end: 1920 }]);
	const { tags, track, packets } = await readWav(buffer);

	// The loop points must survive the round trip through the 'smpl' chunk
	expect(tags.loops).toEqual([{ start: 480, end: 1920 }]);

	// ...while the audio data stays untouched
	await expectMonoAudioSegments(track, packets);
});

test('WAVE file with multiple sample loops', async () => {
	const buffer = await writeMonoWav([
		{ start: 480, end: 960 },
		{ start: 1440, end: 1920 },
	]);
	const { tags, track, packets } = await readWav(buffer);

	// Loops come back in the order they were written
	expect(tags.loops).toEqual([
		{ start: 480, end: 960 },
		{ start: 1440, end: 1920 },
	]);

	await expectMonoAudioSegments(track, packets);
});

test('WAVE file without sample loops', async () => {
	const buffer = await writeMonoWav();
	const { tags, track, packets } = await readWav(buffer);

	expect(tags.loops).toBeUndefined();

	await expectMonoAudioSegments(track, packets);
});

test('WAVE file with metadata tags, stereo 44.1 kHz', async () => {
	for (const metadataFormat of [undefined, 'id3'] as const) {
		const output = new Output({
			format: new WavOutputFormat(metadataFormat ? { metadataFormat } : {}),
			target: new BufferTarget(),
		});

		output.setMetadataTags({
			title: '循环句',
			artist: 'Ahe',
			comment: 'take',
		});

		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);

		await output.start();

		const data = new Uint8Array(1764); // 441 frames of pcm-s16 stereo @ 44100 Hz = 10 ms
		data[0] = 7;
		data[2] = 9;
		await source.add(new EncodedPacket(data, 'key', 0, 0.01), {
			decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 44100 },
		});

		await output.finalize();

		using input = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const tags = await input.getMetadataTags();

		if (metadataFormat === 'id3') {
			// ID3v2 supports Unicode, so the Chinese title survives
			expect(tags.title).toBe('循环句');
		} else {
			// RIFF INFO is limited to ISO 8859-1, so the Chinese title cannot be written
			expect(tags.title).toBeUndefined();
		}
		expect(tags.artist).toBe('Ahe');
		expect(tags.comment).toBe('take');
		expect(tags.loops).toBeUndefined();

		const track = await input.getPrimaryAudioTrack();
		assert(track);

		expect(await track.getSampleRate()).toBe(44100);
		expect(await track.getNumberOfChannels()).toBe(2);
		expect(await track.getDurationFromMetadata()).toBe(0.01);

		const sink = new EncodedPacketSink(track);
		const packets: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}

		expect(packets).toHaveLength(1);
		expect(packets[0]!.byteLength).toBe(1764);
		expect(packets[0]!.timestamp).toBe(0);
		expect(packets[0]!.duration).toBe(0.01);
		expect(packets[0]!.timestamp + packets[0]!.duration).toBe(0.01);
		expect(packets[0]!.data[0]).toBe(7);
		expect(packets[0]!.data[2]).toBe(9);
	}
});
