"""Put the launcher in a non-inheritable, kill-on-close Windows Job.

All descendants inherit membership, including detached processes. Windows closes
the handle on console close or a crash, terminating the complete service tree.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes as w


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("ProcessTime", ctypes.c_int64), ("JobTime", ctypes.c_int64), ("Flags", w.DWORD),
        ("MinWorking", ctypes.c_size_t), ("MaxWorking", ctypes.c_size_t),
        ("ActiveLimit", w.DWORD), ("Affinity", ctypes.c_size_t),
        ("Priority", w.DWORD), ("Scheduling", w.DWORD),
    ]


class IOCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in
               ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("Basic", BasicLimits), ("IO", IOCounters),
               ("ProcessMemory", ctypes.c_size_t), ("JobMemory", ctypes.c_size_t),
               ("PeakProcess", ctypes.c_size_t), ("PeakJob", ctypes.c_size_t)]


class WindowsJob:
    def __init__(self):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        kernel.CreateJobObjectW.restype = w.HANDLE
        kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        kernel.SetInformationJobObject.restype = w.BOOL
        kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        kernel.AssignProcessToJobObject.restype = w.BOOL
        kernel.GetCurrentProcess.restype = w.HANDLE
        kernel.CloseHandle.argtypes = [w.HANDLE]
        kernel.CloseHandle.restype = w.BOOL
        handle = kernel.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        info = ExtendedLimits()
        info.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            error = ctypes.WinError(ctypes.get_last_error())
            kernel.CloseHandle(handle)
            raise error
        if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
            error = ctypes.WinError(ctypes.get_last_error())
            kernel.CloseHandle(handle)
            raise error
        self.kernel, self.handle = kernel, handle

    def close(self):
        # This also terminates the launcher itself. Print/flush final messages first.
        self.kernel.CloseHandle(self.handle)
