"""데바니온 링크의 창입니다. 표준 라이브러리의 tkinter만 씁니다.

캡처와 판독은 link_capture.CaptureWorker가 뒤쪽 스레드에서 하고, 이 창은 큐에 들어온 소식을 주기적으로 꺼내 보여 줍니다.
"""

import queue
import subprocess
import sys
import tkinter as tk
import webbrowser
from tkinter import ttk

import link_capture as capture
import link_core as core


TITLE = "데바니온 링크"
POLL_MS = 100
BOARDS_PER_LINE = 3
WRAP = 520
RUNNING = ("starting", "awaiting-admin", "capturing")
TK_PROBE = "import tkinter; root = tkinter.Tk(); root.withdraw(); root.update(); root.destroy()"
TK_BROKEN = ("이 파이썬에 들어 있는 Tk로는 창을 띄울 수 없습니다. macOS에 기본으로 들어 있는 Tk 8.5는 최근 macOS에서 "
             "창을 만들기 전에 프로그램을 중단시킵니다. python.org에서 받은 파이썬이나 Tk 8.6 이상이 연결된 파이썬으로 "
             "실행하거나, 묶어 둔 실행 파일을 사용하십시오. 저장한 캡처는 --read로 읽을 수 있습니다.")


def boards_text(state):
    """보드별 열린 노드 수입니다. 시작 노드도 셉니다."""
    if state is None or not state.boards:
        return "없음"
    cells = [f"{core.board_name(board)} {len(nodes)}개" for board, nodes in sorted(state.boards.items())]
    lines = [" · ".join(cells[index:index + BOARDS_PER_LINE]) for index in range(0, len(cells), BOARDS_PER_LINE)]
    if not state.boards_complete:
        lines.append("(접속할 때의 보드 정보가 없어 그 뒤에 바뀐 노드만 셉니다.)")
    return "\n".join(lines)


def skills_text(state):
    if state is None or not (state.skills or state.skills_complete):
        return "없음"
    boosted = sum(1 for _level, daevanion in state.skills.values() if daevanion)
    text = f"{len(state.skills)}개 (데바니온 노드로 오른 스킬 {boosted}개)"
    if state.skills_unreadable and not state.skills_complete:
        return text + " · 스킬 목록을 읽지 못했습니다."
    if not state.skills_complete:
        return text + " · 스킬 목록을 기다리고 있습니다."
    return text


def power_text(value):
    return f"{value:,}" if value else "없음"


class LinkWindow:
    def __init__(self, root, port=core.GAME_PORT, site=None, interface=None, opener=webbrowser.open):
        self.root = root
        self.port = port
        self.opener = opener
        self.config = core.load_config()
        # 명령줄로 받은 값은 이번 실행에만 씁니다. 창에서 바꾼 값만 설정 파일에 남깁니다.
        self.preferred = interface or self.config["interface"]  # 비어 있으면 기본 경로의 인터페이스를 고릅니다.
        self.shown_site = site or self.config["site"]
        self.events = queue.Queue()
        self.worker = None
        self.phase = "idle"
        self.detail = ""
        self.state = None
        self.closed = False
        self.interfaces = []
        self.build(self.shown_site)
        self.load_interfaces()
        self.render()
        root.protocol("WM_DELETE_WINDOW", self.close)
        if sys.platform == "darwin":
            # macOS의 종료 메뉴(Cmd-Q)는 창 닫기를 거치지 않으므로 같은 정리를 하도록 잇습니다.
            try:
                root.createcommand("tk::mac::Quit", self.close)
            except tk.TclError:
                pass
        self.poll_id = root.after(POLL_MS, self.poll)

    # ── 화면 구성 ──

    def build(self, site):
        root = self.root
        root.title(TITLE)
        root.resizable(False, False)
        frame = ttk.Frame(root, padding=14)
        frame.grid(sticky="nsew")
        frame.columnconfigure(1, weight=1)

        self.status = ttk.Label(frame, wraplength=WRAP, justify="left")
        self.status.grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))

        self.values = {}
        for row, (key, label) in enumerate((("power", "현재 전투력"), ("best", "최고 전투력"), ("boards", "보드별 열린 노드"),
                                            ("skills", "읽은 스킬"), ("changed", "마지막 변경")), start=1):
            ttk.Label(frame, text=label).grid(row=row, column=0, sticky="nw", padx=(0, 12), pady=2)
            value = ttk.Label(frame, wraplength=WRAP - 140, justify="left")
            value.grid(row=row, column=1, sticky="w", pady=2)
            self.values[key] = value

        ttk.Separator(frame).grid(row=6, column=0, columnspan=2, sticky="ew", pady=10)

        ttk.Label(frame, text="인터페이스").grid(row=7, column=0, sticky="w", padx=(0, 12), pady=2)
        self.interface = ttk.Combobox(frame, state="readonly", width=36)
        self.interface.grid(row=7, column=1, sticky="ew", pady=2)
        self.interface.bind("<<ComboboxSelected>>", self.on_interface)

        ttk.Label(frame, text="사이트 주소").grid(row=8, column=0, sticky="w", padx=(0, 12), pady=2)
        self.site = tk.StringVar(value=site)
        entry = ttk.Entry(frame, textvariable=self.site, width=38)
        entry.grid(row=8, column=1, sticky="ew", pady=2)
        entry.bind("<FocusOut>", lambda _event: self.remember())
        entry.bind("<Return>", lambda _event: self.remember())

        capture_row = ttk.Frame(frame)
        capture_row.grid(row=9, column=0, columnspan=2, sticky="w", pady=(12, 0))
        self.start_button = ttk.Button(capture_row, text="캡처 시작", command=self.start)
        self.start_button.grid(row=0, column=0, padx=(0, 6))
        self.stop_button = ttk.Button(capture_row, text="중지", command=self.stop)
        self.stop_button.grid(row=0, column=1, padx=(0, 6))
        # macOS에서 캡처 권한이 없을 때만 보입니다.
        self.admin_button = ttk.Button(capture_row, text="관리자 권한으로 캡처", command=lambda: self.start(privileged=True))

        link_row = ttk.Frame(frame)
        link_row.grid(row=10, column=0, columnspan=2, sticky="w", pady=(8, 0))
        self.open_button = ttk.Button(link_row, text="웹에서 재계산", command=self.open_web)
        self.open_button.grid(row=0, column=0, padx=(0, 6))
        self.copy_button = ttk.Button(link_row, text="링크 복사", command=self.copy_link)
        self.copy_button.grid(row=0, column=1)

        self.notice = ttk.Label(frame, wraplength=WRAP, justify="left")
        self.notice.grid(row=11, column=0, columnspan=2, sticky="w", pady=(8, 0))

    def load_interfaces(self):
        self.interfaces = capture.list_interfaces()
        names = [interface.name for interface in self.interfaces]
        self.interface["values"] = [interface.label for interface in self.interfaces]
        selected = self.preferred if self.preferred in names else capture.default_interface(self.interfaces)
        if selected in names:
            self.interface.current(names.index(selected))

    def selected_interface(self):
        index = self.interface.current()
        return self.interfaces[index].name if 0 <= index < len(self.interfaces) else None

    def on_interface(self, _event=None):
        self.preferred = self.selected_interface() or ""
        self.remember(interface=self.preferred)

    # ── 표시 ──

    def running(self):
        return self.worker is not None and self.worker.is_alive()

    def render(self):
        state = self.state
        running = self.running()
        phase = self.phase
        self.status["text"] = core.status_text(phase, state, self.detail)
        self.values["power"]["text"] = power_text(state.power if state else 0)
        self.values["best"]["text"] = power_text(state.best_power if state else 0)
        self.values["boards"]["text"] = boards_text(state)
        self.values["skills"]["text"] = skills_text(state)
        self.values["changed"]["text"] = core.clock(state.changed_at if state else None)

        self.start_button["state"] = "disabled" if running else "normal"
        self.stop_button["state"] = "normal" if running else "disabled"
        self.interface["state"] = "disabled" if running else "readonly"
        ready = "normal" if state is not None and state.complete else "disabled"
        self.open_button["state"] = ready
        self.copy_button["state"] = ready
        if sys.platform == "darwin" and phase == "permission" and not running:
            self.admin_button.grid(row=0, column=2)
        else:
            self.admin_button.grid_remove()

    def say(self, text):
        self.notice["text"] = text

    def poll(self):
        if self.closed:
            return
        changed = False
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == "status":
                    self.phase, self.detail = event[1], event[2]
                elif event[0] == "state":
                    self.state = event[1]
                changed = True
        except queue.Empty:
            pass
        if self.phase in RUNNING and not self.running() and self.events.empty():
            # 캡처 스레드가 끝났는데 마지막 소식이 없습니다. 멈춘 것으로 보여 줍니다.
            self.phase, changed = "stopped", True
        if changed:
            self.render()
        self.poll_id = self.root.after(POLL_MS, self.poll)

    # ── 동작 ──

    def start(self, privileged=False):
        if self.running():
            return
        name = self.selected_interface()
        if not name:
            self.say("캡처할 인터페이스를 고르십시오.")
            return
        self.say("")
        self.state = None
        self.events = queue.Queue()  # 이전 캡처가 남긴 소식은 버립니다.
        try:
            source = capture.live_source(name, self.port, privileged)
        except capture.CaptureError as error:
            self.phase, self.detail = error.code, error.detail
            self.render()
            return
        self.worker = capture.CaptureWorker(source, self.events, self.port)
        self.phase, self.detail = "starting", ""
        self.worker.start()
        self.render()

    def stop(self):
        if self.worker is not None:
            self.worker.stop()

    def site_address(self):
        return self.site.get().strip() or core.DEFAULT_SITE

    def remember(self, interface=None):
        """창에서 바꾼 사이트 주소와 직접 고른 인터페이스를 설정 파일에 남깁니다."""
        config = dict(self.config)
        site = self.site_address()
        if site != self.shown_site:
            try:
                core.site_base(site)
            except ValueError:
                pass  # 쓸 수 없는 주소는 남기지 않습니다. 링크를 만들 때 이유를 알립니다.
            else:
                config["site"] = self.shown_site = site
        if interface is not None:
            config["interface"] = interface
        if config == self.config:
            return
        try:
            core.save_config(config)
        except OSError:
            return
        self.config = config

    def link(self):
        if self.state is None or not self.state.complete:
            return None
        try:
            url, dropped = core.link_parts(self.site_address(), self.state)
        except ValueError as error:
            self.say(str(error))
            return None
        self.remember()
        note = f" 링크를 2,000자 아래로 줄이려고 스킬 {dropped}개를 뺐습니다." if dropped else ""
        return url, note

    def open_web(self):
        made = self.link()
        if made is None:
            return
        url, note = made
        try:
            opened = self.opener(url)
        except Exception:  # 브라우저를 여는 방식은 환경마다 달라 실패를 한 가지로 다룹니다.
            opened = False
        self.say(("브라우저에서 웹 계산기를 열었습니다." if opened
                  else "브라우저를 열지 못했습니다. 링크 복사를 누른 뒤 브라우저 주소창에 붙여 넣으십시오.") + note)

    def copy_link(self):
        made = self.link()
        if made is None:
            return
        url, note = made
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        self.say("링크를 복사했습니다." + note)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.remember()
        self.root.withdraw()
        worker = self.worker
        if worker is not None and worker.is_alive():
            worker.stop()
            worker.join(timeout=8)
        try:
            self.root.after_cancel(self.poll_id)
        except tk.TclError:
            pass
        self.root.destroy()


def tk_usable():
    """이 파이썬의 Tk가 창을 만들 수 있는지 봅니다.

    macOS에 들어 있는 Tk 8.5는 맞지 않는 OS에서 예외가 아니라 프로세스 중단으로 실패하므로, 다른 프로세스에서 먼저 열어 봅니다.
    Tk 8.6 이상이거나 묶은 실행 파일이면 확인하지 않습니다.
    """
    if sys.platform != "darwin" or tk.TkVersion >= 8.6 or getattr(sys, "frozen", False):
        return True
    try:
        probe = subprocess.run([sys.executable, "-c", TK_PROBE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


def run(port=core.GAME_PORT, site=None, interface=None, autostart=False, close_after=None):
    """창을 띄웁니다. close_after(초)는 창이 뜨는지만 확인할 때 씁니다."""
    if not tk_usable():
        print(TK_BROKEN, file=sys.stderr)
        return 1
    root = tk.Tk()
    window = LinkWindow(root, port=port, site=site, interface=interface)
    if autostart:
        root.after(0, window.start)
    if close_after is not None:
        root.after(int(close_after * 1000), window.close)
    root.mainloop()
    return 0
