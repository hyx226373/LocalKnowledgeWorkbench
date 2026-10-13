using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal static class ReapOrphans {
    const uint TH32CS_SNAPPROCESS = 2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct UNICODE_STRING {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 pe);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 pe);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr h, int flags, char[] name, ref int size);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr info, int len, out int ret);

    struct Proc {
        public uint Pid, Ppid;
        public string Name, Image, Command;
    }

    static List<Proc> Snapshot() {
        var list = new List<Proc>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return list;
        try {
            var pe = new PROCESSENTRY32();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snap, ref pe)) return list;
            do {
                list.Add(new Proc { Pid = pe.th32ProcessID, Ppid = pe.th32ParentProcessID, Name = pe.szExeFile ?? "" });
                pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            } while (Process32Next(snap, ref pe));
        } finally { CloseHandle(snap); }
        return list;
    }

    static string ImageOf(uint pid) {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "";
        try {
            var buf = new char[1024];
            int size = buf.Length;
            if (!QueryFullProcessImageName(h, 0, buf, ref size)) return "";
            return new string(buf, 0, size);
        } finally { CloseHandle(h); }
    }

    static string CommandOf(uint pid) {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x0400, false, pid);
        if (h == IntPtr.Zero) return "";
        try {
            int need = 0;
            NtQueryInformationProcess(h, ProcessCommandLineInformation, IntPtr.Zero, 0, out need);
            if (need < 32) need = 4096;
            IntPtr buf = Marshal.AllocHGlobal(need);
            try {
                int status = NtQueryInformationProcess(h, ProcessCommandLineInformation, buf, need, out need);
                if (status != 0) return "";
                var us = Marshal.PtrToStructure<UNICODE_STRING>(buf);
                if (us.Length == 0) return "";
                long addr = us.Buffer.ToInt64();
                long start = buf.ToInt64();
                if (addr > 0 && addr < 65536) addr = start + addr;
                if (addr < start || addr > start + 1000000) return "";
                return Marshal.PtrToStringUni(new IntPtr(addr), us.Length / 2) ?? "";
            } finally { Marshal.FreeHGlobal(buf); }
        } finally { CloseHandle(h); }
    }

    static Proc Fill(Proc p) {
        p.Image = ImageOf(p.Pid);
        p.Command = CommandOf(p.Pid);
        return p;
    }

    static void WriteProc(Proc p) {
        string cmd = (p.Command ?? "").Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
        Console.WriteLine(p.Pid + "\t" + p.Ppid + "\t" + (p.Name ?? "") + "\t" + (p.Image ?? "") + "\t" + cmd);
    }

    static int Main(string[] args) {
        if (args.Length < 2) {
            Console.Error.WriteLine("usage: reap-orphans.exe query|children <pid> [pid...]");
            return 2;
        }
        string mode = args[0];
        var pids = new List<uint>();
        for (int i = 1; i < args.Length; i++) {
            uint n;
            if (uint.TryParse(args[i], out n) && n > 0) pids.Add(n);
        }
        if (pids.Count == 0) return 2;
        var all = Snapshot();
        if (mode == "query") {
            var want = new HashSet<uint>(pids);
            foreach (var p in all) {
                if (!want.Contains(p.Pid)) continue;
                WriteProc(Fill(p));
            }
            return 0;
        }
        if (mode == "children") {
            uint root = pids[0];
            var kids = new HashSet<uint>();
            bool grew = true;
            while (grew) {
                grew = false;
                foreach (var p in all) {
                    if (p.Pid == root || kids.Contains(p.Pid)) continue;
                    if (p.Ppid == root || kids.Contains(p.Ppid)) {
                        kids.Add(p.Pid);
                        grew = true;
                    }
                }
            }
            foreach (var p in all) {
                if (!kids.Contains(p.Pid)) continue;
                WriteProc(Fill(p));
            }
            return 0;
        }
        Console.Error.WriteLine("unknown mode");
        return 2;
    }
}
