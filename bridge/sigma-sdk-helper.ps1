# Optional SIGMA Camera Control SDK adapter for MOTK Shoot.
# The proprietary SDK is supplied by the user and is never redistributed here.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('probe', 'preview', 'capture')]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string]$SdkZip,

    [string]$Serial = '',
    [string]$Output = '',
    [string]$OutputDir = '',
    [string]$BaseName = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Result([hashtable]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
}

function Fail([string]$Message) {
    Write-Result @{ ok = $false; error = $Message }
    exit 1
}

function Resolve-SigmaSerial([string]$Requested) {
    if ($Requested) { return $Requested }
    $device = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
        Where-Object { $_.PNPDeviceID -match '^USB\\VID_1003&PID_C432\\(.+)$' } |
        Select-Object -First 1
    if (-not $device) {
        throw 'SIGMA fp was not found. Set USB mode to Camera Control, reconnect USB, or pass --sigma-serial.'
    }
    return ([regex]::Match($device.PNPDeviceID, '^USB\\VID_1003&PID_C432\\(.+)$')).Groups[1].Value
}

function Get-SdkDirectory([string]$ZipPath) {
    $resolved = (Resolve-Path -LiteralPath $ZipPath).Path
    if ([IO.Path]::GetExtension($resolved) -ne '.zip') { throw 'SIGMA SDK path must be the original .zip file.' }
    $hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.Substring(0, 16)
    $root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "MOTKShoot\sigma-sdk-$hash"
    $required = @(
        'SIGMA_cmd.dll', 'SIGMA_ConfigAPI.dll', 'SIGMA_CloseApplication.dll',
        'SIGMA_GetCamViewFrame.dll', 'SIGMA_SnapCommand.dll',
        'SIGMA_GetCamStatus2.dll', 'SIGMA_GetCamCaptStatus.dll',
        'SIGMA_ClearImageDBSingle.dll',
        'SIGMA_GetPictFileInfo2.dll', 'SIGMA_GetBigPartialPictFile.dll'
    )
    if (-not (Test-Path -LiteralPath $root)) { [IO.Directory]::CreateDirectory($root) | Out-Null }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($resolved)
    try {
        foreach ($name in $required) {
            $entry = $archive.Entries | Where-Object {
                $_.FullName -like "*/SDK/dll/$name" -or $_.FullName -like "*/SampleProgram/$name"
            } | Select-Object -First 1
            if (-not $entry) { throw "The SDK ZIP is missing $name." }
            $target = Join-Path $root $name
            if (-not (Test-Path -LiteralPath $target) -or (Get-Item -LiteralPath $target).Length -ne $entry.Length) {
                $temp = "$target.tmp-$PID"
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $temp, $true)
                if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temp, $target, $null) }
                else { [IO.File]::Move($temp, $target) }
            }
            $signature = Get-AuthenticodeSignature -LiteralPath $target
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=SIGMA CORPORATION') {
                throw "$name does not have a valid SIGMA CORPORATION signature."
            }
        }
    } finally {
        $archive.Dispose()
    }
    return $root
}

try {
    $sdkDir = Get-SdkDirectory $SdkZip
    $resolvedSerial = Resolve-SigmaSerial $Serial
    [Environment]::SetEnvironmentVariable('PATH', "$sdkDir;$env:PATH", 'Process')
    $source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class MotkSigmaSdk {
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct SdkInfo {
        public IntPtr lpInterface, hMultipleOpenSync, lpDataIn, lpDataOut, lpDataInBig, lpDataOutBig;
        public uint dwDataInSize, dwDataOutSize, dwLastSendSize, dwLastRecvSize;
        public int bLastUseBugBuffer, bUseBuffer;
        public uint dwDataInSizeBig, dwDataOutSizeBig;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct SnapState { public byte CaptureMode, CaptureAmount; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct IfdArray { public uint DirectoryCount; public IntPtr Directory; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct CaptureStatus {
        public byte ImageId, DatabaseHead, DatabaseTail;
        public ushort Status;
        public byte Destination;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1, CharSet = CharSet.Ansi)]
    public struct PictureInfo {
        public ushort PictureFormat;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 4)] public byte[] FileExt;
        public ushort SizeX, SizeY;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)] public byte[] PathName;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)] public byte[] FileName;
        public uint FileSize, FileAddress;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetDllDirectory(string path);
    [DllImport("SIGMA_cmd.dll", CallingConvention = CallingConvention.Winapi, CharSet = CharSet.Ansi)]
    static extern int sgm_CamOpen(string serialNumber, ref SdkInfo info);
    [DllImport("SIGMA_cmd.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_CamClose(ref SdkInfo info);
    [DllImport("SIGMA_ConfigAPI.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_ConfigAPI(ref SdkInfo info, out IfdArray config);
    [DllImport("SIGMA_CloseApplication.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_CloseApplication(ref SdkInfo info);
    [DllImport("SIGMA_cmd.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_FreeArrayMemory(ref IfdArray value);
    [DllImport("SIGMA_GetCamViewFrame.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamViewFrame(ref SdkInfo info, out IntPtr buffer, out uint actualSize);
    [DllImport("SIGMA_SnapCommand.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_SnapCommand(ref SdkInfo info, ref SnapState state);
    [DllImport("SIGMA_GetCamStatus2.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamStatus2(ref SdkInfo info, uint canSet, uint groups, uint other,
        IntPtr status, int bufferLength, out int receivedLength);
    [DllImport("SIGMA_GetCamCaptStatus.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamCaptStatus(ref SdkInfo info, uint imageId, out CaptureStatus status);
    [DllImport("SIGMA_ClearImageDBSingle.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_ClearImageDBSingle(ref SdkInfo info, int imageId);
    [DllImport("SIGMA_GetPictFileInfo2.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetPictFileInfo2(ref SdkInfo info, IntPtr pictures,
        uint maxCount, out uint actualCount, out IntPtr buffer, out int dataLength);
    [DllImport("SIGMA_GetBigPartialPictFile.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetBigPartialPictFile(ref SdkInfo info, uint storeAddress,
        uint startAddress, uint length, out IntPtr data, out uint actualSize);

    static void Check(int result, string operation) {
        if (result < 0) throw new InvalidOperationException(operation + " failed (HRESULT 0x" + result.ToString("X8") + ").");
    }
    static string Text(byte[] value) {
        int end = Array.IndexOf(value, (byte)0); if (end < 0) end = value.Length;
        return System.Text.Encoding.ASCII.GetString(value, 0, end).Trim();
    }
    static PictureInfo[] ReadPictures(ref SdkInfo info, bool wait) {
        const int maximum = 16;
        int size = Marshal.SizeOf(typeof(PictureInfo));
        IntPtr memory = Marshal.AllocHGlobal(size * maximum);
        try {
            var zero = new byte[size * maximum]; Marshal.Copy(zero, 0, memory, zero.Length);
            uint count = 0; IntPtr metadata; int metadataLength; var deadline = DateTime.UtcNow.AddSeconds(45);
            do {
                if (wait) System.Threading.Thread.Sleep(250);
                Check(sgm_GetPictFileInfo2(ref info, memory, maximum, out count, out metadata, out metadataLength), "sgm_GetPictFileInfo2");
            } while (wait && count == 0 && DateTime.UtcNow < deadline);
            if (wait && count == 0) throw new TimeoutException("Timed out waiting for the camera image.");
            if (count > maximum) throw new InvalidDataException("Camera returned too many image records.");
            var pictures = new PictureInfo[count];
            for (int i = 0; i < count; i++) pictures[i] = (PictureInfo)Marshal.PtrToStructure(IntPtr.Add(memory, i * size), typeof(PictureInfo));
            return pictures;
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static CaptureStatus CaptureDatabase(ref SdkInfo info) {
        IntPtr buffer = Marshal.AllocHGlobal(64 * 1024);
        try {
            int received; Check(sgm_GetCamStatus2(ref info, 0, 0, 0, buffer, 64 * 1024, out received), "sgm_GetCamStatus2");
            CaptureStatus status; Check(sgm_GetCamCaptStatus(ref info, 0, out status), "sgm_GetCamCaptStatus");
            return status;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void ClearPendingCaptures(ref SdkInfo info) {
        var database = CaptureDatabase(ref info);
        byte id = database.DatabaseHead;
        for (int count = 0; count < 256 && id != database.DatabaseTail; count++, id++) {
            try { sgm_ClearImageDBSingle(ref info, id); } catch {}
        }
    }
    static void WaitForCapture(ref SdkInfo info, byte imageId) {
        IntPtr statusBuffer = Marshal.AllocHGlobal(64 * 1024);
        try {
            var deadline = DateTime.UtcNow.AddSeconds(45);
            while (DateTime.UtcNow < deadline) {
                int received; Check(sgm_GetCamStatus2(ref info, 0, 0, 0, statusBuffer, 64 * 1024, out received), "sgm_GetCamStatus2");
                CaptureStatus status; Check(sgm_GetCamCaptStatus(ref info, imageId, out status), "sgm_GetCamCaptStatus");
                if (status.Status == 0x0005 || status.Status == 0x8003) return;
                if (status.Status >= 0x6001 && status.Status <= 0x6FFF) throw new InvalidOperationException("Camera capture failed (status 0x" + status.Status.ToString("X4") + ").");
                System.Threading.Thread.Sleep(150);
            }
            throw new TimeoutException("Timed out waiting for the camera to finish the image.");
        } finally { Marshal.FreeHGlobal(statusBuffer); }
    }
    static SdkInfo Open(string sdkDirectory, string serial) {
        if (!SetDllDirectory(sdkDirectory)) throw new InvalidOperationException("Could not set the SDK DLL directory.");
        var info = new SdkInfo(); Check(sgm_CamOpen(serial, ref info), "sgm_CamOpen");
        var config = new IfdArray();
        try { Check(sgm_ConfigAPI(ref info, out config), "sgm_ConfigAPI"); }
        catch { try { sgm_CamClose(ref info); } catch {} throw; }
        finally { if (config.Directory != IntPtr.Zero) try { sgm_FreeArrayMemory(ref config); } catch {} }
        return info;
    }
    static void Close(ref SdkInfo info) {
        try { sgm_CloseApplication(ref info); } catch {}
        try { sgm_CamClose(ref info); } catch {}
    }

    public static void Probe(string sdkDirectory, string serial) {
        var info = Open(sdkDirectory, serial); Close(ref info);
    }

    public static void Preview(string sdkDirectory, string serial, string output) {
        var info = Open(sdkDirectory, serial);
        try {
            IntPtr data = IntPtr.Zero; uint size = 0; int result = -1;
            var deadline = DateTime.UtcNow.AddSeconds(10);
            do {
                result = sgm_GetCamViewFrame(ref info, out data, out size);
                if (result >= 0 && data != IntPtr.Zero && size >= 4) break;
                System.Threading.Thread.Sleep(150);
            } while (DateTime.UtcNow < deadline);
            Check(result, "sgm_GetCamViewFrame");
            if (data == IntPtr.Zero || size < 4 || size > 32 * 1024 * 1024) throw new InvalidDataException("Camera returned no valid preview frame.");
            var bytes = new byte[size]; Marshal.Copy(data, bytes, 0, checked((int)size)); AtomicWrite(output, ExtractJpeg(bytes));
        } finally { Close(ref info); }
    }

    public static string[] Capture(string sdkDirectory, string serial, string outputDirectory, string baseName) {
        Directory.CreateDirectory(outputDirectory);
        var info = Open(sdkDirectory, serial);
        try {
            ClearPendingCaptures(ref info);
            byte imageId = CaptureDatabase(ref info).DatabaseTail;
            var snap = new SnapState { CaptureMode = 0x02, CaptureAmount = 0x01 };
            Check(sgm_SnapCommand(ref info, ref snap), "sgm_SnapCommand");
            WaitForCapture(ref info, imageId);
            var pictures = ReadPictures(ref info, true);

            var saved = new System.Collections.Generic.List<string>();
            for (int i = 0; i < pictures.Length; i++) {
                var p = pictures[i];
                string original = Text(p.FileName);
                string ext = Path.GetExtension(original);
                if (String.IsNullOrWhiteSpace(ext)) ext = "." + Text(p.FileExt).TrimStart('.');
                if (String.IsNullOrWhiteSpace(ext) || ext.Length > 8) ext = ".bin";
                string suffix = pictures.Length > 1 ? "_" + (i + 1).ToString("00") : "";
                string target = Path.Combine(outputDirectory, baseName + suffix + ext.ToLowerInvariant());
                if (File.Exists(target)) throw new IOException("Refusing to overwrite " + target);
                using (var stream = new MemoryStream(checked((int)p.FileSize))) {
                    uint offset = 0;
                    while (offset < p.FileSize) {
                        // Stay within the SDK's documented large receive page (0xF000).
                        uint request = Math.Min(0xF000u, p.FileSize - offset);
                        IntPtr chunk; uint received;
                        Check(sgm_GetBigPartialPictFile(ref info, p.FileAddress, offset, request, out chunk, out received), "sgm_GetBigPartialPictFile");
                        if (chunk == IntPtr.Zero || received == 0 || received > request + 64) throw new InvalidDataException("Camera returned an invalid image chunk (requested " + request + ", received " + received + ").");
                        var bytes = new byte[received]; Marshal.Copy(chunk, bytes, 0, checked((int)received));
                        int wrapper = checked((int)(received > request ? received - request : 0));
                        int payload = checked((int)received) - wrapper;
                        // The fp can return two 31-byte SDK response envelopes before the payload.
                        if (wrapper != 0 && wrapper != 10 && wrapper != 62) throw new InvalidDataException("Camera returned an unknown image wrapper of " + wrapper + " bytes.");
                        stream.Write(bytes, wrapper, payload); offset += (uint)payload;
                    }
                    if (stream.Length != p.FileSize) throw new InvalidDataException("Downloaded image size does not match camera metadata.");
                    AtomicWrite(target, stream.ToArray());
                }
                saved.Add(target);
            }
            Check(sgm_ClearImageDBSingle(ref info, imageId), "sgm_ClearImageDBSingle");
            return saved.ToArray();
        } finally { Close(ref info); }
    }

    static void AtomicWrite(string target, byte[] bytes) {
        string full = Path.GetFullPath(target); string parent = Path.GetDirectoryName(full);
        if (String.IsNullOrEmpty(parent)) throw new IOException("Output needs a parent directory.");
        Directory.CreateDirectory(parent);
        if (File.Exists(full)) throw new IOException("Refusing to overwrite " + full);
        string temp = full + ".tmp-" + System.Diagnostics.Process.GetCurrentProcess().Id + "-" + Guid.NewGuid().ToString("N");
        try { File.WriteAllBytes(temp, bytes); File.Move(temp, full); } finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    static byte[] ExtractJpeg(byte[] value) {
        int start = -1, end = -1;
        for (int i = 0; i + 1 < value.Length; i++) {
            if (start < 0 && value[i] == 0xFF && value[i + 1] == 0xD8) start = i;
            if (start >= 0 && value[i] == 0xFF && value[i + 1] == 0xD9) end = i + 2;
        }
        if (start < 0 || end <= start) throw new InvalidDataException("Camera preview did not contain a complete JPEG.");
        var jpeg = new byte[end - start]; Buffer.BlockCopy(value, start, jpeg, 0, jpeg.Length); return jpeg;
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp

    switch ($Command) {
        'probe' {
            [MotkSigmaSdk]::Probe($sdkDir, $resolvedSerial)
            Write-Result @{ ok = $true; camera = 'SIGMA fp' }
        }
        'preview' {
            if (-not $Output) { throw '-Output is required for preview.' }
            [MotkSigmaSdk]::Preview($sdkDir, $resolvedSerial, $Output)
            Write-Result @{ ok = $true; output = [IO.Path]::GetFullPath($Output) }
        }
        'capture' {
            if (-not $OutputDir -or -not $BaseName) { throw '-OutputDir and -BaseName are required for capture.' }
            if ($BaseName -notmatch '^kdr_[0-9]{8}_[0-9]{6}_[0-9]{4}$') { throw 'Unsafe capture base name.' }
            $files = [MotkSigmaSdk]::Capture($sdkDir, $resolvedSerial, $OutputDir, $BaseName)
            Write-Result @{ ok = $true; files = @($files) }
        }
    }
} catch {
    Fail $_.Exception.Message
}
