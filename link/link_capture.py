"""데바니온 링크의 실시간 캡처입니다. 화면 코드는 없습니다.

macOS와 Linux는 tcpdump의 출력을 읽고, Windows는 scapy(Npcap)로 직접 캡처합니다. 캡처와 판독은 뒤쪽 스레드에서 돌고
결과는 큐로 넘깁니다. 관리자 암호는 이 프로그램이 받거나 보관하지 않습니다.
"""

import collections
import os
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types

from scapy.all import PcapReader, Scapy_Exception, conf

from link_core import GAME_PORT, Demux, Tracker
from measure_cp import capture_command


Interface = collections.namedtuple("Interface", "name label")
ADMIN_PROMPT = "데바니온 링크가 게임 패킷을 읽기 위해 tcpdump를 실행합니다."
PERMISSION_WORDS = ("permission", "operation not permitted", "access is denied", "권한")


class CaptureError(Exception):
    """캡처를 시작하지 못했거나 캡처가 스스로 끝났습니다. code는 link_core.status_text의 상태 이름입니다."""

    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def permission_problem(text):
    text = text.lower()
    return any(word in text for word in PERMISSION_WORDS)


def npcap_missing():
    """Windows에서 scapy가 wpcap.dll을 불러오지 못했는지 봅니다. scapy는 그럴 때 use_pcap을 꺼 둡니다."""
    return sys.platform == "win32" and not conf.use_pcap


# ── 인터페이스 ──────────────────────────────────────────────────────────

def device_name(iface):
    """캡처에 넘길 장치 이름입니다. Windows에서는 \\Device\\NPF_{...}, 그 밖에서는 en0 같은 이름입니다."""
    return str(getattr(iface, "network_name", None) or getattr(iface, "name", None) or iface)


def is_loopback(iface):
    flags = str(getattr(iface, "flags", "")).upper()
    return "LOOPBACK" in flags or device_name(iface) == conf.loopback_name or getattr(iface, "name", "") == conf.loopback_name


def list_interfaces(ifaces=None):
    """고를 수 있는 인터페이스 목록입니다. IPv4 주소가 있는 것을 앞에 두고, 루프백과 내려가 있는 것은 뺍니다."""
    try:
        ifaces = list(conf.ifaces.values()) if ifaces is None else list(ifaces)
    except Exception:  # 인터페이스 조회는 플랫폼마다 실패 방식이 달라 이름 목록으로 물러납니다.
        ifaces = []
    found = []
    for iface in ifaces:
        try:
            usable = iface.is_valid()  # scapy가 플랫폼에 맞게 "올라와 있음"을 판단합니다.
        except Exception:
            usable = True
        if is_loopback(iface) or not usable:
            continue
        address = getattr(iface, "ip", None)
        address = address if address and address != "0.0.0.0" else ""
        name = str(getattr(iface, "name", "") or device_name(iface))
        found.append((not address, len(found), Interface(device_name(iface), f"{name} · {address}" if address else name)))
    if not found:
        try:
            names = [name for _index, name in socket.if_nameindex()]
        except (AttributeError, OSError):
            names = []
        return [Interface(name, name) for name in names if not name.startswith("lo")]
    return [interface for _no_address, _order, interface in sorted(found)]


def default_interface(interfaces, routes=None):
    """기본 경로(0.0.0.0/0)가 나가는 인터페이스를 고릅니다. 알 수 없으면 목록의 첫 인터페이스입니다."""
    names = [interface.name for interface in interfaces]
    try:
        routes = conf.route.routes if routes is None else routes
        defaults = sorted((route for route in routes if route[0] == 0 and route[1] == 0), key=lambda route: route[5])
    except Exception:  # 경로표를 읽지 못하면 아래의 첫 인터페이스로 갑니다.
        defaults = []
    for route in defaults:
        name = device_name(route[3])
        if name in names:
            return name
    return names[0] if names else None


# ── 캡처 명령 ───────────────────────────────────────────────────────────

def tcpdump_command(interface, port=GAME_PORT, output="-"):
    """measure_cp.capture_command가 만드는 tcpdump 명령입니다. output을 주면 표준 출력 대신 그 파일에 씁니다."""
    command = capture_command(types.SimpleNamespace(port=port, server=None, client_port=None, interface=interface))
    command[command.index("-w") + 1] = output
    return command


def capture_filter(port=GAME_PORT):
    """tcpdump에 주는 것과 같은 BPF 필터입니다."""
    return tcpdump_command("any", port)[-1]


def privileged_shell(command, error_path, run_path, pid):
    """관리자 권한으로 실행할 셸 한 줄입니다.

    command를 뒤에서 돌리고 1초마다 살핍니다. 프로그램(pid)이 없어졌거나 run_path 파일이 지워졌으면 command를 끝내고 나옵니다.
    관리자 권한 프로세스는 이 프로그램이 직접 끝낼 수 없으므로 run_path를 지우는 것이 중지 신호입니다.
    """
    capture = " ".join(shlex.quote(part) for part in command)
    return (f"umask 022; {capture} >/dev/null 2>{shlex.quote(error_path)} & T=$!; "
            f"while kill -0 {int(pid)} 2>/dev/null && kill -0 $T 2>/dev/null && [ -e {shlex.quote(run_path)} ]; "
            "do sleep 1; done; kill $T 2>/dev/null; wait $T 2>/dev/null; exit 0")


def applescript(shell, prompt=ADMIN_PROMPT):
    """셸 한 줄을 macOS의 관리자 권한 요청으로 감쌉니다. 암호는 macOS의 창이 받습니다."""
    def quoted(text):
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return f"do shell script {quoted(shell)} with prompt {quoted(prompt)} with administrator privileges"


class FollowFile:
    """다른 프로세스가 쓰고 있는 캡처 파일을 끝에서 기다리며 읽습니다.

    쓰는 쪽이 살아 있는 동안에는 요청한 길이를 다 채울 때까지 기다립니다. 모자란 채로 돌려주면 pcap 레코드 경계가 어긋납니다.
    """

    def __init__(self, path, alive, poll=0.2):
        self.name = str(path)
        self.file = open(path, "rb")
        self.alive = alive
        self.poll = poll

    def read(self, size=-1):
        if size is None or size < 0:
            return self.file.read()
        data = b""
        while len(data) < size:
            chunk = self.file.read(size - len(data))
            if chunk:
                data += chunk
            elif not self.alive():
                # 쓰는 쪽이 끝났습니다. 마지막으로 남은 것만 읽고 끝냅니다.
                data += self.file.read(size - len(data))
                break
            else:
                time.sleep(self.poll)
        return data

    def close(self):
        self.file.close()


def read_packets(source, on_packet):
    """pcap 스트림을 끝까지 읽습니다. 캡처 헤더도 없이 끝났으면 False입니다."""
    try:
        capture = PcapReader(source)
    except Scapy_Exception:
        return False
    with capture:
        for packet in capture:
            on_packet(packet)
    return True


# ── 캡처 원본 ───────────────────────────────────────────────────────────
# 원본은 run(on_packet, report)에서 캡처가 끝날 때까지 머물고, stop()은 다른 스레드에서 부릅니다.

class TcpdumpSource:
    """tcpdump를 실행해 표준 출력의 pcap을 읽습니다. macOS와 Linux에서 씁니다."""

    def __init__(self, interface, port=GAME_PORT):
        self.command = tcpdump_command(interface, port)
        self.process = None
        self.stopping = threading.Event()

    def run(self, on_packet, report):
        try:
            self.process = subprocess.Popen(self.command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except FileNotFoundError as error:
            raise CaptureError("no-tcpdump") from error
        if self.stopping.is_set():
            # 프로세스를 띄우는 사이에 중지를 눌렀습니다.
            self.close()
            return
        messages = []

        def watch():
            # tcpdump는 장치를 열면 표준 오류에 "listening on …"을 적습니다.
            for line in self.process.stderr:
                text = line.decode("utf-8", "replace")
                messages.append(text)
                if "listening on" in text:
                    report("capturing")

        watcher = threading.Thread(target=watch, name="daevanion-link-tcpdump-stderr", daemon=True)
        watcher.start()
        try:
            read_packets(self.process.stdout, on_packet)
        finally:
            self.close()
            watcher.join(timeout=2)
            self.process.stdout.close()
            self.process.stderr.close()
        if self.stopping.is_set():
            return
        text = "".join(messages).strip()
        raise CaptureError("permission" if permission_problem(text) else "ended",
                           text or f"tcpdump 종료 코드 {self.process.returncode}")

    def close(self):
        process = self.process
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def stop(self):
        self.stopping.set()
        self.close()


class PrivilegedSource:
    """macOS에서 tcpdump만 관리자 권한으로 실행하고, 임시 pcap 파일을 따라 읽습니다.

    암호는 macOS의 관리자 권한 창이 받습니다. 관리자 권한으로 도는 셸은 이 프로그램이 없어지면 tcpdump를 스스로 끝냅니다.
    """

    def __init__(self, interface, port=GAME_PORT, launcher=None):
        self.interface = interface
        self.port = port
        # launcher는 셸 한 줄을 받아 실행 명령을 돌려줍니다. 테스트에서는 관리자 권한 요청 없이 /bin/sh로 바꿉니다.
        self.launcher = launcher or (lambda shell: ["/usr/bin/osascript", "-e", applescript(shell)])
        self.stopping = threading.Event()
        self.process = None
        self.folder = None

    def capture_command(self, output):
        command = tcpdump_command(self.interface, self.port, output)
        command[0] = shutil.which("tcpdump") or "/usr/sbin/tcpdump"
        return command

    def run(self, on_packet, report):
        self.folder = tempfile.mkdtemp(prefix="daevanion-link-")
        pcap = os.path.join(self.folder, "capture.pcap")
        errors = os.path.join(self.folder, "tcpdump.log")
        run_file = os.path.join(self.folder, "running")
        try:
            open(run_file, "w").close()
            shell = privileged_shell(self.capture_command(pcap), errors, run_file, os.getpid())
            self.process = subprocess.Popen(self.launcher(shell), stdin=subprocess.DEVNULL,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            report("awaiting-admin")
            # tcpdump는 장치를 연 뒤에 출력 파일을 만듭니다.
            while not os.path.exists(pcap):
                if self.stopping.is_set():
                    return
                if self.process.poll() is not None:
                    raise self.failure(errors)
                time.sleep(0.2)
            report("capturing")
            source = FollowFile(pcap, lambda: self.process.poll() is None and not self.stopping.is_set())
            try:
                read_packets(source, on_packet)
            finally:
                source.close()
            if not self.stopping.is_set():
                raise self.failure(errors)
        finally:
            self.close()

    def failure(self, errors):
        try:
            _out, text = self.process.communicate(timeout=5)
            text = text.decode("utf-8", "replace")
        except (subprocess.TimeoutExpired, ValueError, OSError):
            text = ""
        if "-128" in text or "cancel" in text.lower():
            return CaptureError("cancelled")
        try:
            with open(errors, encoding="utf-8", errors="replace") as log:
                text = (log.read() + "\n" + text).strip()
        except OSError:
            pass
        return CaptureError("permission" if permission_problem(text) else "ended", text.strip())

    def close(self):
        folder, self.folder = self.folder, None
        if folder is None:
            return
        # 실행 표시 파일을 지우면 관리자 권한 셸이 1초 안에 tcpdump를 끝냅니다.
        try:
            os.unlink(os.path.join(folder, "running"))
        except OSError:
            pass
        process = self.process
        if process is not None and process.poll() is None:
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                # 승인 창이 떠 있는 채로 멈춘 경우입니다. 창을 띄운 osascript만 끝냅니다.
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
        if process is not None and process.stderr is not None:
            process.stderr.close()
        shutil.rmtree(folder, ignore_errors=True)

    def stop(self):
        self.stopping.set()


class SniffSource:
    """scapy로 직접 캡처합니다. Windows에서 쓰며 Npcap이 있어야 합니다. tcpdump와 같은 필터를 씁니다."""

    def __init__(self, interface, port=GAME_PORT, **options):
        self.options = {"iface": interface, "filter": capture_filter(port), "promisc": False}
        self.options.update(options)
        self.stopping = threading.Event()
        self.sniffer = None
        self.failure = None

    def run(self, on_packet, report):
        from scapy.all import AsyncSniffer

        if self.options.get("offline") is None and npcap_missing():
            # Npcap은 사용자가 직접 설치합니다. 이 프로그램은 설치 파일을 내려받지 않습니다.
            raise CaptureError("npcap")

        def deliver(packet):
            # scapy는 여기서 난 예외를 경고만 남기고 삼키므로 따로 적어 둡니다.
            try:
                on_packet(packet)
            except Exception as error:
                self.failure = error
                raise

        self.sniffer = AsyncSniffer(prn=deliver, store=False, started_callback=lambda: report("capturing"),
                                    **self.options)
        self.sniffer.start()
        thread = self.sniffer.thread
        while thread.is_alive() and not self.stopping.wait(0.2):
            pass
        # 장치를 여는 중에는 중지 요청이 먹지 않으므로 스레드가 끝날 때까지 다시 요청합니다.
        deadline = time.monotonic() + 5
        while thread.is_alive() and time.monotonic() < deadline:
            try:
                self.sniffer.stop(join=False)
            except Scapy_Exception:
                pass
            thread.join(timeout=0.2)
        error = self.failure or self.sniffer.exception
        if self.stopping.is_set() and error is None:
            return
        if error is None:
            raise CaptureError("ended", "")
        text = f"{type(error).__name__}: {error}"
        if "winpcap is not installed" in text.lower() or "npcap" in text.lower():
            raise CaptureError("npcap", text) from error
        raise CaptureError("permission" if isinstance(error, PermissionError) or permission_problem(text) else "error",
                           text) from error

    def stop(self):
        self.stopping.set()


def live_source(interface, port=GAME_PORT, privileged=False):
    """이 운영체제에서 쓸 캡처 원본입니다."""
    if sys.platform == "win32":
        return SniffSource(interface, port)
    if privileged:
        if sys.platform != "darwin":
            raise CaptureError("error", "관리자 권한 캡처는 macOS에서만 지원합니다.")
        return PrivilegedSource(interface, port)
    return TcpdumpSource(interface, port)


# ── 뒤쪽 스레드 ─────────────────────────────────────────────────────────

class CaptureWorker(threading.Thread):
    """캡처 원본을 읽어 상태를 추적하고, 화면 쪽 큐에 ("status", 이름, 설명)과 ("state", 상태 사본)을 넣습니다."""

    def __init__(self, source, events, port=GAME_PORT, interval=1.0):
        super().__init__(name="daevanion-link-capture", daemon=True)
        self.source = source
        self.events = events
        self.tracker = Tracker()
        self.demux = Demux(port)
        self.interval = interval
        self.posted = 0.0
        self.packets = 0

    def run(self):
        self.report("starting")
        try:
            self.source.run(self.on_packet, self.report)
        except CaptureError as error:
            self.post_state()
            self.report(error.code, error.detail)
            return
        except Exception as error:  # 캡처 스레드가 말없이 죽지 않도록 창에 알립니다.
            self.post_state()
            self.report("error", f"{type(error).__name__}: {error}")
            return
        self.post_state()
        self.report("stopped")

    def report(self, code, detail=""):
        self.events.put(("status", code, detail))

    def post_state(self):
        state = self.tracker.state
        self.events.put(("state", None if state is None else state.copy()))

    def on_packet(self, packet):
        self.packets += 1
        changed = False
        for event in self.demux.feed(packet):
            changed = self.tracker.dispatch(*event) or changed
        now = time.monotonic()
        # 바뀐 것이 없어도 가끔 보내 "패킷이 오고 있음"을 화면이 알게 합니다.
        if changed or now - self.posted >= self.interval:
            self.posted = now
            self.post_state()

    def stop(self):
        self.source.stop()
