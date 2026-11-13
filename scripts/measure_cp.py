#!/usr/bin/env python3
"""아이온2 캡처에서 자기 캐릭터의 전투력 수치를 읽습니다."""

import argparse
import ipaddress
import re
import signal
import struct
import subprocess
import sys

try:
    from lz4 import block as lz4
    from scapy.all import IP, IPv6, TCP, Padding, PcapReader, Scapy_Exception
except ModuleNotFoundError as error:
    sys.exit(f"캡처 판독 라이브러리를 설치하십시오. python3 -m pip install -r scripts/requirements-cp.txt ({error.name})")


GAME_PORT = 13328
POWER_OPCODE = b"\x56\x36"
COMPRESSED_OPCODE = b"\xff\xff"
MARKERS = re.compile(rb"\x56\x36|(?=\xff\xff)")
MAX_POWER = 5_000_000
MAX_UNCOMPRESSED = 2 * 1024 * 1024
MAX_FRAME = MAX_UNCOMPRESSED + 64 * 1024
SEQUENCE_MASK = 0xFFFFFFFF


def frame_header(data, start):
    """완성된 헤더의 프레임 끝과 명령 번호 위치를 반환합니다."""
    size = 0
    for index in range(5):
        offset = start + index
        if offset >= len(data):
            return None
        byte = data[offset]
        size |= (byte & 0x7F) << (index * 7)
        if byte < 0x80:
            opcode = offset + 1
            end = opcode + size - 4
            if end < opcode + 2 or end - start > MAX_FRAME:
                raise ValueError("프레임 길이 범위 초과")
            if opcode >= len(data):
                return None
            if 0xF0 <= data[opcode] <= 0xFE:
                opcode += 1
            if end < opcode + 2:
                raise ValueError("명령 번호가 프레임 범위를 초과했습니다.")
            return end, opcode
    raise ValueError("길이 varint가 너무 깁니다.")


def frame_powers(data, opcode, end, depth=0):
    """일반 프레임 또는 LZ4 묶음에서 전투력 값을 읽습니다."""
    command = data[opcode:opcode + 2]
    payload = opcode + 2
    if command == POWER_OPCODE:
        if end - payload != 16:
            return None
        power, second = struct.unpack_from("<QQ", data, payload)
        return [power] if 0 < power <= MAX_POWER and 0 < second <= MAX_POWER else None
    if command != COMPRESSED_OPCODE:
        return []
    if depth >= 3 or end - payload < 5:
        return None
    decoded_size = struct.unpack_from("<I", data, payload)[0]
    if not 0 < decoded_size <= MAX_UNCOMPRESSED:
        return None
    try:
        decoded = lz4.decompress(bytes(data[payload + 4:end]), uncompressed_size=decoded_size)
    except (lz4.LZ4BlockError, OverflowError, ValueError):
        return None
    if not decoded:
        return None
    powers = []
    offset = 0
    skipped = 0
    while offset < len(decoded):
        try:
            header = frame_header(decoded, offset)
        except ValueError:
            header = None
        if header is None or header[0] > len(decoded):
            offset += 1
            skipped += 1
            if skipped == 16:
                return powers or None
            continue
        end, opcode = header
        powers.extend(frame_powers(decoded, opcode, end, depth + 1) or [])
        offset = end
        skipped = 0
    return powers


def find_frame(data, offset):
    """연결 중간에서 캡처를 시작한 경우 검증 가능한 프레임을 찾습니다."""
    for match in MARKERS.finditer(data, offset):
        opcode = match.start()
        command = data[opcode:opcode + 2]
        for start in range(opcode - 1, max(offset, opcode - 6) - 1, -1):
            try:
                header = frame_header(data, start)
            except ValueError:
                continue
            if header is None or header[1] != opcode:
                continue
            end = header[0]
            if command == POWER_OPCODE and end != opcode + 18:
                continue
            if command == COMPRESSED_OPCODE:
                if end < opcode + 7:
                    continue
                if opcode + 6 > len(data):
                    return start, None
                size = struct.unpack_from("<I", data, opcode + 2)[0]
                if not 0 < size <= MAX_UNCOMPRESSED:
                    continue
            if end > len(data):
                return start, None
            powers = frame_powers(data, opcode, end)
            if powers is not None:
                return end, powers
    return max(offset, len(data) - 10), None


class FrameStream:
    def __init__(self, aligned=False):
        self.aligned = aligned
        self.buffer = bytearray()

    def feed(self, chunk):
        self.buffer.extend(chunk)
        powers = []
        offset = 0
        while offset < len(self.buffer):
            if not self.aligned:
                offset, found = find_frame(self.buffer, offset)
                if found is None:
                    break
                powers.extend(found)
                self.aligned = True
                continue
            try:
                header = frame_header(self.buffer, offset)
            except ValueError:
                self.aligned = False
                offset += 1
                continue
            if header is None or header[0] > len(self.buffer):
                break
            end, opcode = header
            powers.extend(frame_powers(self.buffer, opcode, end) or [])
            offset = end
        del self.buffer[:offset]
        return powers


def sequence_distance(seq, expected):
    return ((seq - expected + (1 << 31)) & SEQUENCE_MASK) - (1 << 31)


class TcpStream:
    def __init__(self, seq, syn, frames=FrameStream):
        self.syn = seq if syn else None
        self.expected = (seq + syn) & SEQUENCE_MASK
        self.new_frames = frames
        self.frames = frames(aligned=syn)
        self.pending = {}

    def feed(self, seq, payload):
        distance = sequence_distance(seq, self.expected)
        if distance > MAX_FRAME or (distance > 0 and len(self.pending) >= 128):
            self.expected = seq
            self.frames = self.new_frames()
            self.pending.clear()
            distance = 0
        if distance > 0:
            if len(payload) > len(self.pending.get(seq, b"")):
                self.pending[seq] = payload
            return []
        powers = self.consume(payload, -distance)
        # 겹치는 재전송은 아직 읽지 않은 부분만 사용합니다.
        while self.pending:
            seq = min(self.pending, key=lambda start: sequence_distance(start, self.expected))
            distance = sequence_distance(seq, self.expected)
            if distance > 0:
                break
            powers.extend(self.consume(self.pending.pop(seq), -distance))
        return powers

    def consume(self, payload, skip):
        if skip >= len(payload):
            return []
        self.expected = (self.expected + len(payload) - skip) & SEQUENCE_MASK
        return self.frames.feed(payload[skip:])


def captured(source, args, frames=FrameStream):
    """서버에서 온 스트림을 재조립해 (패킷 시각, 판독한 값)을 순서대로 냅니다."""
    streams = {}
    with PcapReader(source) as capture:
        for packet in capture:
            tcp = packet.getlayer(TCP)
            if tcp is None or tcp.sport != args.port:
                continue
            if args.client_port is not None and tcp.dport != args.client_port:
                continue
            network = tcp.underlayer
            while network is not None and not isinstance(network, (IP, IPv6)):
                network = network.underlayer
            if network is None or (args.server and network.src != args.server):
                continue
            flow = (network.src, tcp.sport, network.dst, tcp.dport)
            syn = bool(tcp.flags.S)
            stream = streams.get(flow)
            payload = bytes(tcp.payload)
            padding = tcp.payload.getlayer(Padding)
            if padding is not None:
                payload = payload[:len(payload) - len(padding)]
            if stream is None and not (syn or payload):
                continue
            if stream is None or (syn and stream.syn != tcp.seq):
                if len(streams) >= 32 and flow not in streams:
                    streams.pop(next(iter(streams)))
                stream = streams[flow] = TcpStream(tcp.seq, syn, frames)
            if payload:
                seq = (tcp.seq + syn) & SEQUENCE_MASK
                for value in stream.feed(seq, payload):
                    yield float(packet.time), value
            if tcp.flags.F or tcp.flags.R:
                streams.pop(flow, None)


def captured_powers(source, args):
    for _time, power in captured(source, args):
        yield power


def show_power(power, before):
    if before is None:
        print(power, flush=True)
    else:
        print(f"{power} ({power - before:+d})", flush=True)


def capture_timeout(_signal, _frame):
    raise TimeoutError("대기 시간 안에 전투력 갱신을 받지 못했습니다.")


def capture_command(args):
    """서버에서 클라이언트로 오는 방향만 표준 출력으로 내보내는 tcpdump 명령입니다."""
    capture_filter = f"tcp src port {args.port}"
    if args.server:
        capture_filter += f" and src host {args.server}"
    if args.client_port is not None:
        capture_filter += f" and dst port {args.client_port}"
    return ["tcpdump", "-n", "-p", "-U", "-s", "0", "-i", args.interface, "-w", "-", capture_filter]


def measure_once(args):
    if not hasattr(signal, "SIGALRM"):
        raise ValueError("이 환경에서는 --read로 저장된 캡처를 읽으십시오.")
    command = capture_command(args)
    previous = signal.signal(signal.SIGALRM, capture_timeout)
    try:
        with subprocess.Popen(command, stdout=subprocess.PIPE) as process:
            powers = captured_powers(process.stdout, args)
            try:
                signal.setitimer(signal.ITIMER_REAL, args.timeout)
                power = next(powers, None)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                powers.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
    finally:
        signal.signal(signal.SIGALRM, previous)
    if power is None:
        raise ValueError("캡처가 전투력 갱신 없이 종료되었습니다.")
    show_power(power, args.before)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--interface", help="캡처할 네트워크 인터페이스에서 전투력 한 건을 기다립니다.")
    source.add_argument("--read", metavar="PCAP", help="저장한 pcap 또는 pcapng의 전투력을 순서대로 읽습니다.")
    parser.add_argument("--port", type=int, default=GAME_PORT, help="서버 TCP 포트. 기본값 13328")
    parser.add_argument("--client-port", type=int, help="로컬 TCP 포트로 연결을 좁힙니다.")
    parser.add_argument("--server", type=ipaddress.ip_address, help="서버 IP로 연결을 좁힙니다.")
    parser.add_argument("--before", type=int, help="변경 전 수치를 넣으면 전투력 차이도 표시합니다.")
    parser.add_argument("--timeout", type=int, default=30, help="한 건을 기다릴 시간. 기본값 30초")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or (args.client_port is not None and not 1 <= args.client_port <= 65535):
        parser.error("포트는 1~65535 범위로 지정하십시오.")
    if args.before is not None and not 0 < args.before <= MAX_POWER:
        parser.error("변경 전 전투력은 1~5000000 범위로 입력하십시오.")
    if args.timeout < 1:
        parser.error("대기 시간은 1초 이상으로 지정하십시오.")
    args.server = str(args.server) if args.server else None
    return args


def main():
    args = parse_args()
    try:
        if args.interface:
            measure_once(args)
        else:
            found = False
            for power in captured_powers(args.read, args):
                show_power(power, args.before)
                found = True
            if not found:
                raise ValueError("캡처에서 전투력 갱신을 찾지 못했습니다.")
    except (OSError, ValueError, Scapy_Exception) as error:
        print(error, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
