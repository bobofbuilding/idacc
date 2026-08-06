using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class IdaccJobHost {
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint CREATE_SUSPENDED = 0x00000004;
  private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  private const uint CREATE_NO_WINDOW = 0x08000000;
  private const uint STARTF_USESTDHANDLES = 0x00000100;
  private const uint HANDLE_FLAG_INHERIT = 0x00000001;
  private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const int JobObjectBasicAccountingInformation = 1;
  private const int JobObjectExtendedLimitInformation = 9;
  private const long PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
  private const long PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
  private const uint WAIT_TIMEOUT = 0x00000102;
  private const uint STILL_ACTIVE = 259;
  private const int STD_OUTPUT_HANDLE = -11;
  private const int STD_ERROR_HANDLE = -12;
  private const int MAX_CONFIG_CHARS = 262144;
  private const int MAX_CONTROL_CHARS = 160;
  private const int MAX_QUEUED_CONTROL_LINES = 8;
  private const int MAX_ARGUMENTS = 32;
  private const int ACK_TIMEOUT_MS = 10000;
  private const int FORCE_WAIT_MS = 5000;
  private const int JOB_EMPTY_WAIT_MS = 5000;
  private const int DRAIN_FAILED_EXIT_CODE = 125;
  private const int HOST_FAILED_EXIT_CODE = 126;
  private const int NO_CHILD_CREATED_EXIT_CODE = 127;
  private const int CREATED_JOB_DRAINED_EXIT_CODE = 128;
  private const string ProtocolPrefix = "IDACC_JOB_HOST";
  // These process-local proof bits are read only if Run throws. They let Main
  // publish a cleanup classification without exposing paths or exception text.
  private static bool managedChildCreated;
  private static bool managedJobEmptyConfirmed;

  private enum AcknowledgementOutcome {
    Acknowledged,
    StopRequested,
    ControlLost
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public int bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  private sealed class Configuration {
    public string Nonce;
    public uint ParentPid;
    public int GraceMs;
    public string Executable;
    public string WorkingDirectory;
    public string[] Arguments;
  }

  private sealed class ControlReader {
    private readonly Queue<string> lines = new Queue<string>();
    private readonly AutoResetEvent available = new AutoResetEvent(false);
    private bool closed;

    public ControlReader() {
      Thread thread = new Thread(ReadLoop);
      thread.IsBackground = true;
      thread.Name = "idacc-job-control";
      thread.Start();
    }

    private void ReadLoop() {
      try {
        string line;
        while ((line = ReadBoundedLine(Console.In, MAX_CONTROL_CHARS)) != null) {
          lock (lines) {
            if (lines.Count >= MAX_QUEUED_CONTROL_LINES) {
              closed = true;
              available.Set();
              return;
            }
            lines.Enqueue(line);
          }
          available.Set();
        }
      } catch {
        // A broken supervisor pipe is equivalent to supervisor death.
      } finally {
        lock (lines) {
          closed = true;
        }
        available.Set();
      }
    }

    public bool TryTake(out string line) {
      lock (lines) {
        if (lines.Count > 0) {
          line = lines.Dequeue();
          return true;
        }
      }
      line = null;
      return false;
    }

    public bool IsClosed {
      get {
        lock (lines) {
          return closed && lines.Count == 0;
        }
      }
    }

    public void Wait(int milliseconds) {
      available.WaitOne(milliseconds);
    }
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(
    IntPtr jobAttributes,
    string name
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    IntPtr information,
    uint informationLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int informationClass,
    out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
    uint informationLength,
    IntPtr returnLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(
    IntPtr job,
    uint exitCode
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsProcessInJob(
    IntPtr process,
    IntPtr job,
    out bool result
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool InitializeProcThreadAttributeList(
    IntPtr attributeList,
    int attributeCount,
    int flags,
    ref IntPtr size
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool UpdateProcThreadAttribute(
    IntPtr attributeList,
    uint flags,
    IntPtr attribute,
    IntPtr value,
    IntPtr size,
    IntPtr previousValue,
    IntPtr returnSize
  );

  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(
    IntPtr attributeList
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFOEX startupInfo,
    out PROCESS_INFORMATION processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CreatePipe(
    out IntPtr readPipe,
    out IntPtr writePipe,
    ref SECURITY_ATTRIBUTES attributes,
    uint size
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetHandleInformation(
    IntPtr handle,
    uint mask,
    uint flags
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool DuplicateHandle(
    IntPtr sourceProcess,
    IntPtr sourceHandle,
    IntPtr targetProcess,
    out IntPtr targetHandle,
    uint desiredAccess,
    bool inheritHandle,
    uint options
  );

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentProcessId();

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetStdHandle(int standardHandle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(
    uint desiredAccess,
    bool inheritHandle,
    uint processId
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(
    IntPtr handle,
    uint milliseconds
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(
    IntPtr process,
    out uint exitCode
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static bool IsValidHandle(IntPtr handle) {
    return handle != IntPtr.Zero && handle != new IntPtr(-1);
  }

  private static void Close(ref IntPtr handle) {
    if (IsValidHandle(handle)) {
      CloseHandle(handle);
    }
    handle = IntPtr.Zero;
  }

  private static string Decode(string value) {
    byte[] bytes = Convert.FromBase64String(value);
    string decoded = new UTF8Encoding(false, true).GetString(bytes);
    if (decoded.IndexOf('\0') >= 0) {
      throw new InvalidOperationException("invalid string");
    }
    return decoded;
  }

  private static string ReadBoundedLine(
    System.IO.TextReader reader,
    int maximumCharacters
  ) {
    StringBuilder line = new StringBuilder(
      Math.Min(maximumCharacters, 1024)
    );
    while (true) {
      int next = reader.Read();
      if (next < 0) {
        return line.Length == 0 ? null : line.ToString();
      }
      if (next == '\n') {
        if (line.Length > 0 && line[line.Length - 1] == '\r') {
          line.Length -= 1;
        }
        return line.ToString();
      }
      if (line.Length >= maximumCharacters) {
        throw new InvalidOperationException("protocol line too long");
      }
      line.Append((char)next);
    }
  }

  private static string NormalizeLocalDrivePath(string value) {
    if (
      String.IsNullOrEmpty(value) ||
      value.Length < 3 ||
      !Char.IsLetter(value[0]) ||
      value[1] != ':' ||
      (value[2] != '\\' && value[2] != '/') ||
      value.StartsWith(@"\\", StringComparison.Ordinal) ||
      value.IndexOf(':', 2) >= 0
    ) {
      throw new InvalidOperationException("invalid local path");
    }
    string normalized = System.IO.Path.GetFullPath(value);
    if (
      normalized.Length < 3 ||
      !Char.IsLetter(normalized[0]) ||
      normalized[1] != ':' ||
      normalized[2] != '\\' ||
      normalized.StartsWith(@"\\", StringComparison.Ordinal) ||
      normalized.IndexOf(':', 2) >= 0
    ) {
      throw new InvalidOperationException("invalid normalized path");
    }
    return normalized;
  }

  private static Configuration ReadConfiguration() {
    string line = ReadBoundedLine(Console.In, MAX_CONFIG_CHARS);
    if (line == null || line.Length < 1) {
      throw new InvalidOperationException("invalid configuration");
    }
    string[] fields = line.Split('\t');
    if (
      fields.Length < 9 ||
      fields[0] != "IDACC_JOB_CONFIG" ||
      fields[1] != "1"
    ) {
      throw new InvalidOperationException("invalid protocol");
    }
    string nonce = fields[2];
    uint parentPid;
    int graceMs;
    int argumentCount;
    if (
      nonce.Length != 64 ||
      !UInt32.TryParse(fields[3], out parentPid) ||
      parentPid < 1 ||
      !Int32.TryParse(fields[4], out graceMs) ||
      graceMs < 1000 ||
      graceMs > 30000 ||
      !Int32.TryParse(fields[7], out argumentCount) ||
      argumentCount < 1 ||
      argumentCount > MAX_ARGUMENTS ||
      fields.Length != 8 + argumentCount
    ) {
      throw new InvalidOperationException("invalid configuration values");
    }
    for (int index = 0; index < nonce.Length; index += 1) {
      char current = nonce[index];
      if (!((current >= '0' && current <= '9') || (current >= 'a' && current <= 'f'))) {
        throw new InvalidOperationException("invalid nonce");
      }
    }
    string executable = NormalizeLocalDrivePath(Decode(fields[5]));
    string workingDirectory = NormalizeLocalDrivePath(Decode(fields[6]));
    if (
      !System.IO.File.Exists(executable) ||
      !System.IO.Directory.Exists(workingDirectory)
    ) {
      throw new InvalidOperationException("managed process path unavailable");
    }
    string[] arguments = new string[argumentCount];
    for (int index = 0; index < argumentCount; index += 1) {
      arguments[index] = Decode(fields[8 + index]);
    }
    return new Configuration {
      Nonce = nonce,
      ParentPid = parentPid,
      GraceMs = graceMs,
      Executable = executable,
      WorkingDirectory = workingDirectory,
      Arguments = arguments,
    };
  }

  private static string QuoteArgument(string value) {
    if (value.Length == 0) {
      return "\"\"";
    }
    bool quote = false;
    for (int index = 0; index < value.Length; index += 1) {
      char current = value[index];
      if (Char.IsWhiteSpace(current) || current == '"') {
        quote = true;
        break;
      }
    }
    if (!quote) {
      return value;
    }
    StringBuilder result = new StringBuilder();
    result.Append('"');
    int slashes = 0;
    for (int index = 0; index < value.Length; index += 1) {
      char current = value[index];
      if (current == '\\') {
        slashes += 1;
        continue;
      }
      if (current == '"') {
        result.Append('\\', slashes * 2 + 1);
        result.Append('"');
        slashes = 0;
        continue;
      }
      result.Append('\\', slashes);
      slashes = 0;
      result.Append(current);
    }
    result.Append('\\', slashes * 2);
    result.Append('"');
    return result.ToString();
  }

  private static StringBuilder CommandLine(Configuration config) {
    StringBuilder command = new StringBuilder(QuoteArgument(config.Executable));
    for (int index = 0; index < config.Arguments.Length; index += 1) {
      command.Append(' ');
      command.Append(QuoteArgument(config.Arguments[index]));
    }
    if (command.Length > 32766) {
      throw new InvalidOperationException("command line too long");
    }
    return command;
  }

  private static void ConfigureKillOnClose(IntPtr job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
      new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(limits, buffer, false);
      if (!SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        buffer,
        (uint)length
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  private static bool ParentExited(IntPtr parent) {
    uint result = WaitForSingleObject(parent, 0);
    return result != WAIT_TIMEOUT;
  }

  private static bool ProcessExited(IntPtr process) {
    uint result = WaitForSingleObject(process, 0);
    return result != WAIT_TIMEOUT;
  }

  private static bool TerminateAndDrainJob(IntPtr job, IntPtr root) {
    if (IsValidHandle(job)) {
      TerminateJobObject(job, 1);
    }
    if (IsValidHandle(root)) {
      WaitForSingleObject(root, FORCE_WAIT_MS);
    }
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(JOB_EMPTY_WAIT_MS);
    while (DateTime.UtcNow < deadline) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      if (!QueryInformationJobObject(
        job,
        JobObjectBasicAccountingInformation,
        out accounting,
        (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
        IntPtr.Zero
      )) {
        break;
      }
      if (accounting.ActiveProcesses == 0) {
        return true;
      }
      Thread.Sleep(20);
    }
    return false;
  }

  private static AcknowledgementOutcome WaitForAck(
    ControlReader control,
    IntPtr parent,
    string nonce
  ) {
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(ACK_TIMEOUT_MS);
    while (DateTime.UtcNow < deadline) {
      if (ParentExited(parent) || control.IsClosed) {
        return AcknowledgementOutcome.ControlLost;
      }
      string line;
      while (control.TryTake(out line)) {
        if (line == "ACK\t" + nonce) {
          return AcknowledgementOutcome.Acknowledged;
        }
        if (line == "STOP\t" + nonce) {
          return AcknowledgementOutcome.StopRequested;
        }
        return AcknowledgementOutcome.ControlLost;
      }
      control.Wait(20);
    }
    return AcknowledgementOutcome.ControlLost;
  }

  private static int WaitForRuntime(
    Configuration config,
    ControlReader control,
    IntPtr parent,
    IntPtr root,
    ref IntPtr childInputWrite,
    IntPtr job
  ) {
    bool stopRequested = false;
    DateTime stopDeadline = DateTime.MaxValue;
    while (true) {
      if (ParentExited(parent) || control.IsClosed) {
        return TerminateAndDrainJob(job, root)
          ? 0
          : DRAIN_FAILED_EXIT_CODE;
      }
      if (ProcessExited(root)) {
        uint exitCode;
        if (!GetExitCodeProcess(root, out exitCode) || exitCode == STILL_ACTIVE) {
          exitCode = 1;
        }
        Close(ref childInputWrite);
        bool drained = TerminateAndDrainJob(job, root);
        if (!drained) {
          return DRAIN_FAILED_EXIT_CODE;
        }
        if (stopRequested) {
          return 0;
        }
        // 0..124 are reserved for root outcomes that also prove the Job was
        // queried empty. 125..128 are host lifecycle/proof sentinels.
        return exitCode <= 124 ? (int)exitCode : 124;
      }
      string line;
      while (control.TryTake(out line)) {
        if (!stopRequested && line == "STOP\t" + config.Nonce) {
          stopRequested = true;
          stopDeadline = DateTime.UtcNow.AddMilliseconds(config.GraceMs);
          Close(ref childInputWrite);
        }
      }
      if (stopRequested && DateTime.UtcNow >= stopDeadline) {
        return TerminateAndDrainJob(job, root)
          ? 0
          : DRAIN_FAILED_EXIT_CODE;
      }
      control.Wait(20);
    }
  }

  private static int Run() {
    Configuration config = ReadConfiguration();
    ControlReader control = new ControlReader();
    IntPtr parent = IntPtr.Zero;
    IntPtr job = IntPtr.Zero;
    IntPtr attributeList = IntPtr.Zero;
    IntPtr jobValue = IntPtr.Zero;
    IntPtr handleListValue = IntPtr.Zero;
    IntPtr childInputRead = IntPtr.Zero;
    IntPtr childInputWrite = IntPtr.Zero;
    IntPtr childOutput = IntPtr.Zero;
    IntPtr childError = IntPtr.Zero;
    PROCESS_INFORMATION child = new PROCESS_INFORMATION();
    bool attributeListInitialized = false;
    try {
      parent = OpenProcess(SYNCHRONIZE, false, config.ParentPid);
      if (!IsValidHandle(parent) || ParentExited(parent)) {
        throw new InvalidOperationException("parent unavailable");
      }
      job = CreateJobObject(IntPtr.Zero, null);
      if (!IsValidHandle(job)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      ConfigureKillOnClose(job);

      SECURITY_ATTRIBUTES pipeAttributes = new SECURITY_ATTRIBUTES();
      pipeAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
      pipeAttributes.bInheritHandle = 1;
      if (!CreatePipe(
        out childInputRead,
        out childInputWrite,
        ref pipeAttributes,
        0
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      if (!SetHandleInformation(
        childInputWrite,
        HANDLE_FLAG_INHERIT,
        0
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }

      IntPtr current = GetCurrentProcess();
      if (!DuplicateHandle(
        current,
        GetStdHandle(STD_OUTPUT_HANDLE),
        current,
        out childOutput,
        0,
        true,
        DUPLICATE_SAME_ACCESS
      ) || !DuplicateHandle(
        current,
        GetStdHandle(STD_ERROR_HANDLE),
        current,
        out childError,
        0,
        true,
        DUPLICATE_SAME_ACCESS
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }

      IntPtr attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(
        IntPtr.Zero,
        2,
        0,
        ref attributeSize
      );
      if (attributeSize == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      attributeList = Marshal.AllocHGlobal(attributeSize);
      if (!InitializeProcThreadAttributeList(
        attributeList,
        2,
        0,
        ref attributeSize
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      attributeListInitialized = true;
      jobValue = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobValue, job);
      if (!UpdateProcThreadAttribute(
        attributeList,
        0,
        new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST),
        jobValue,
        new IntPtr(IntPtr.Size),
        IntPtr.Zero,
        IntPtr.Zero
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      handleListValue = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleListValue, 0, childInputRead);
      Marshal.WriteIntPtr(handleListValue, IntPtr.Size, childOutput);
      Marshal.WriteIntPtr(handleListValue, IntPtr.Size * 2, childError);
      if (!UpdateProcThreadAttribute(
        attributeList,
        0,
        new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
        handleListValue,
        new IntPtr(IntPtr.Size * 3),
        IntPtr.Zero,
        IntPtr.Zero
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }

      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      startup.StartupInfo.hStdInput = childInputRead;
      startup.StartupInfo.hStdOutput = childOutput;
      startup.StartupInfo.hStdError = childError;
      startup.lpAttributeList = attributeList;
      uint flags =
        CREATE_SUSPENDED |
        CREATE_UNICODE_ENVIRONMENT |
        EXTENDED_STARTUPINFO_PRESENT |
        CREATE_NO_WINDOW;
      if (!CreateProcess(
        config.Executable,
        CommandLine(config),
        IntPtr.Zero,
        IntPtr.Zero,
        true,
        flags,
        IntPtr.Zero,
        config.WorkingDirectory,
        ref startup,
        out child
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      managedChildCreated = true;
      bool assigned;
      if (!IsProcessInJob(child.hProcess, job, out assigned) || !assigned) {
        throw new InvalidOperationException("atomic job assignment failed");
      }
      Close(ref childInputRead);
      Close(ref childOutput);
      Close(ref childError);

      Console.Out.WriteLine(
        ProtocolPrefix + "\tREADY\t1\t" +
        config.Nonce + "\t" +
        GetCurrentProcessId().ToString() + "\t" +
        child.dwProcessId.ToString()
      );
      Console.Out.Flush();
      AcknowledgementOutcome acknowledgement = WaitForAck(
        control,
        parent,
        config.Nonce
      );
      if (acknowledgement != AcknowledgementOutcome.Acknowledged) {
        bool drained = TerminateAndDrainJob(job, child.hProcess);
        if (!drained) {
          return DRAIN_FAILED_EXIT_CODE;
        }
        return acknowledgement == AcknowledgementOutcome.StopRequested
          ? 0
          : HOST_FAILED_EXIT_CODE;
      }
      Console.Out.WriteLine(
        ProtocolPrefix + "\tSTARTED\t1\t" +
        config.Nonce + "\t" +
        GetCurrentProcessId().ToString() + "\t" +
        child.dwProcessId.ToString()
      );
      Console.Out.Flush();
      if (ResumeThread(child.hThread) == UInt32.MaxValue) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      Close(ref child.hThread);
      return WaitForRuntime(
        config,
        control,
        parent,
        child.hProcess,
        ref childInputWrite,
        job
      );
    } finally {
      if (IsValidHandle(job) && IsValidHandle(child.hProcess)) {
        if (TerminateAndDrainJob(job, child.hProcess)) {
          managedJobEmptyConfirmed = true;
        }
      }
      Close(ref child.hThread);
      Close(ref child.hProcess);
      Close(ref childInputRead);
      Close(ref childInputWrite);
      Close(ref childOutput);
      Close(ref childError);
      if (attributeListInitialized) {
        DeleteProcThreadAttributeList(attributeList);
      }
      if (attributeList != IntPtr.Zero) {
        Marshal.FreeHGlobal(attributeList);
      }
      if (jobValue != IntPtr.Zero) {
        Marshal.FreeHGlobal(jobValue);
      }
      if (handleListValue != IntPtr.Zero) {
        Marshal.FreeHGlobal(handleListValue);
      }
      Close(ref job);
      Close(ref parent);
    }
  }

  public static int Main(string[] args) {
    try {
      if (args.Length != 0) {
        return 64;
      }
      Console.InputEncoding = new UTF8Encoding(false, true);
      Console.OutputEncoding = new UTF8Encoding(false);
      return Run();
    } catch {
      // Paths, commands, environment values, credentials, and exception text
      // are intentionally excluded from the host protocol.
      try {
        Console.Error.WriteLine("IDACC_JOB_HOST_ERROR");
        Console.Error.Flush();
      } catch {
        // There is no safe diagnostic channel left.
      }
      if (!managedChildCreated) {
        return NO_CHILD_CREATED_EXIT_CODE;
      }
      return managedJobEmptyConfirmed
        ? CREATED_JOB_DRAINED_EXIT_CODE
        : HOST_FAILED_EXIT_CODE;
    }
  }
}
