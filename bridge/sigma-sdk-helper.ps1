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
    [string]$BaseName = '',
    [ValidateSet(1, 2, 3)]
    [int]$Destination = 2,
    [ValidateSet(0, 2, 4, 8, 16, 18)]
    [int]$ImageQuality = 0
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
        'SIGMA_GetCamDataGrp1.dll',
        'SIGMA_GetCamDataGrp2.dll', 'SIGMA_SetCamDataGrp2.dll',
        'SIGMA_GetCamDataGrp3.dll', 'SIGMA_SetCamDataGrp3.dll',
        'SIGMA_GetCamOpPermission.dll', 'SIGMA_SetCamOpPermission.dll',
        'SIGMA_GetCamDataGroupMovie.dll', 'SIGMA_SetCamDataGroupMovie.dll',
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
    public struct ImageFileDirectory {
        public ushort TagId, Type;
        public uint Count;
        public IntPtr Value;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct CaptureStatus {
        public byte ImageId, DatabaseHead, DatabaseTail;
        public ushort Status;
        public byte Destination;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct DataGroup3 {
        public byte FieldPresent1, FieldPresent2;
        public sbyte Contrast, Sharpness, Saturation, ColorSpace, ColorMode, BatteryKind;
        public ushort LensWideFocalLength, LensTeleFocalLength;
        public sbyte AFAuxiliaryLight, AFBeep, UPSetting, ExtendedMode, AutoRotate, TimerSound, RCChannel, DestinationToSave;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct DataGroup2 {
        public byte FieldPresent1, FieldPresent2;
        public sbyte DriveMode, SpecialMode, ExposureMode, AEMeteringMode, AELock, AFMode, AFAreaMode, AFLock;
        public sbyte FlashType, FlashFire, FlashMode, FlashSetting, FlashExpCompensation, WhiteBalance, Resolution, ImageQuality;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct DataGroup1 {
        public byte FieldPresent1, FieldPresent2;
        public sbyte ShutterSpeed, Aperture, ProgramShift, ISOAuto, ISOSpeed, ExpCompensation, ABValue, ABSetting, FrameBufferState;
        public ushort MediaFreeSpace;
        public sbyte MediaStatus;
        public ushort CurrentLensFocalLength;
        public sbyte BatteryState, AbShotRemainNumber, ExpCompExcludeAB, AfButtonSetting;
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
    [DllImport("SIGMA_GetCamDataGrp1.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamDataGrp1(ref SdkInfo info, out DataGroup1 group);
    [DllImport("SIGMA_GetCamDataGrp2.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamDataGrp2(ref SdkInfo info, out DataGroup2 group);
    [DllImport("SIGMA_SetCamDataGrp2.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_SetCamDataGrp2(ref SdkInfo info, ref DataGroup2 group);
    [DllImport("SIGMA_GetCamDataGrp3.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamDataGrp3(ref SdkInfo info, out DataGroup3 group);
    [DllImport("SIGMA_SetCamDataGrp3.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_SetCamDataGrp3(ref SdkInfo info, ref DataGroup3 group);
    [DllImport("SIGMA_GetCamOpPermission.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamOpPermission(ref SdkInfo info, out IfdArray permission);
    [DllImport("SIGMA_SetCamOpPermission.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_SetCamOpPermission(ref SdkInfo info, ref IfdArray permission);
    [DllImport("SIGMA_GetCamDataGroupMovie.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamDataGroupMovie(ref SdkInfo info, out IfdArray movie);
    [DllImport("SIGMA_SetCamDataGroupMovie.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_SetCamDataGroupMovie(ref SdkInfo info, ref IfdArray movie);
    [DllImport("SIGMA_GetCamStatus2.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamStatus2(ref SdkInfo info, uint canSet, uint groups, uint other,
        IntPtr status, int bufferLength, out int receivedLength);
    [DllImport("SIGMA_GetCamCaptStatus.dll", CallingConvention = CallingConvention.Winapi)]
    static extern int sgm_GetCamCaptStatus(ref SdkInfo info, uint imageId, out CaptureStatus status);
    // SIGMA's exported symbol intentionally contains the SDK header's `Signle` typo.
    [DllImport("SIGMA_ClearImageDBSingle.dll", EntryPoint = "sgm_ClearImageDBSignle", CallingConvention = CallingConvention.Winapi)]
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
            Check(sgm_ClearImageDBSingle(ref info, id), "sgm_ClearImageDBSingle(" + id + ")");
        }
        var cleared = CaptureDatabase(ref info);
        if (cleared.DatabaseHead != cleared.DatabaseTail) throw new InvalidOperationException("Camera capture database did not clear (DB " + cleared.DatabaseHead + "-" + cleared.DatabaseTail + ").");
    }
    static void SelectCaptureDestination(ref SdkInfo info, byte destination) {
        DataGroup3 group;
        Check(sgm_GetCamDataGrp3(ref info, out group), "sgm_GetCamDataGrp3");
        if ((group.FieldPresent2 & 0x80) == 0) throw new NotSupportedException("Camera does not expose a PC capture destination.");
        if (group.DestinationToSave == destination) return;
        group.DestinationToSave = (sbyte)destination;
        Check(sgm_SetCamDataGrp3(ref info, ref group), "sgm_SetCamDataGrp3");
        System.Threading.Thread.Sleep(250);
        Check(sgm_GetCamDataGrp3(ref info, out group), "sgm_GetCamDataGrp3 verification");
        if (group.DestinationToSave != destination) throw new InvalidOperationException("Camera did not accept capture destination 0x" + destination.ToString("X2") + " (reported 0x" + ((byte)group.DestinationToSave).ToString("X2") + ").");
    }
    static void ConfigureStillCapture(ref SdkInfo info, byte imageQuality) {
        DataGroup2 group;
        Check(sgm_GetCamDataGrp2(ref info, out group), "sgm_GetCamDataGrp2");
        if ((group.FieldPresent1 & 0x01) != 0) group.DriveMode = 0x01;
        if ((group.FieldPresent1 & 0x02) != 0) group.SpecialMode = 0x02;
        if ((group.FieldPresent2 & 0x40) != 0) group.Resolution = 0x01;
        if (imageQuality != 0 && (group.FieldPresent2 & 0x80) != 0) group.ImageQuality = (sbyte)imageQuality;
        Check(sgm_SetCamDataGrp2(ref info, ref group), "sgm_SetCamDataGrp2");
    }
    static byte GetOperationPermission(ref SdkInfo info) {
        IfdArray permission;
        Check(sgm_GetCamOpPermission(ref info, out permission), "sgm_GetCamOpPermission");
        try {
            int size = Marshal.SizeOf(typeof(ImageFileDirectory));
            for (int i = 0; i < permission.DirectoryCount; i++) {
                var entry = (ImageFileDirectory)Marshal.PtrToStructure(IntPtr.Add(permission.Directory, i * size), typeof(ImageFileDirectory));
                if (entry.TagId == 0x0001 && entry.Value != IntPtr.Zero && entry.Count > 0) return Marshal.ReadByte(entry.Value);
            }
            throw new InvalidDataException("Camera operation permission was missing from the SDK response.");
        } finally {
            if (permission.Directory != IntPtr.Zero) try { sgm_FreeArrayMemory(ref permission); } catch {}
        }
    }
    static void SelectPcOperation(ref SdkInfo info) {
        byte current = GetOperationPermission(ref info);
        if (current == 0x00 || current == 0x80) return;
        IntPtr value = Marshal.AllocHGlobal(1);
        IntPtr directory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ImageFileDirectory)));
        try {
            Marshal.WriteByte(value, 0x00);
            var entry = new ImageFileDirectory { TagId = 0x0001, Type = 0x0001, Count = 1, Value = value };
            Marshal.StructureToPtr(entry, directory, false);
            var permission = new IfdArray { DirectoryCount = 1, Directory = directory };
            Check(sgm_SetCamOpPermission(ref info, ref permission), "sgm_SetCamOpPermission");
        } finally {
            Marshal.FreeHGlobal(directory);
            Marshal.FreeHGlobal(value);
        }
        var deadline = DateTime.UtcNow.AddSeconds(5);
        byte verified;
        do {
            System.Threading.Thread.Sleep(200);
            verified = GetOperationPermission(ref info);
            if (verified == 0x00 || verified == 0x80) return;
        } while (DateTime.UtcNow < deadline);
        throw new InvalidOperationException("Camera did not enter PC-only operation mode (reported 0x" + verified.ToString("X2") + ").");
    }
    static byte GetStillMovieMode(ref SdkInfo info) {
        IfdArray movie;
        Check(sgm_GetCamDataGroupMovie(ref info, out movie), "sgm_GetCamDataGroupMovie");
        try {
            int size = Marshal.SizeOf(typeof(ImageFileDirectory));
            for (int i = 0; i < movie.DirectoryCount; i++) {
                var entry = (ImageFileDirectory)Marshal.PtrToStructure(IntPtr.Add(movie.Directory, i * size), typeof(ImageFileDirectory));
                if (entry.TagId == 0x0001 && entry.Value != IntPtr.Zero && entry.Count > 0) return Marshal.ReadByte(entry.Value);
            }
            throw new InvalidDataException("Still/movie mode was missing from the SDK response.");
        } finally {
            if (movie.Directory != IntPtr.Zero) try { sgm_FreeArrayMemory(ref movie); } catch {}
        }
    }
    static void SelectStillImageMode(ref SdkInfo info) {
        if (GetStillMovieMode(ref info) == 0x01) return;
        IntPtr value = Marshal.AllocHGlobal(1);
        IntPtr directory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ImageFileDirectory)));
        try {
            Marshal.WriteByte(value, 0x01);
            var entry = new ImageFileDirectory { TagId = 0x0001, Type = 0x0001, Count = 1, Value = value };
            Marshal.StructureToPtr(entry, directory, false);
            var movie = new IfdArray { DirectoryCount = 1, Directory = directory };
            Check(sgm_SetCamDataGroupMovie(ref info, ref movie), "sgm_SetCamDataGroupMovie");
        } finally {
            Marshal.FreeHGlobal(directory);
            Marshal.FreeHGlobal(value);
        }
        var deadline = DateTime.UtcNow.AddSeconds(5);
        do {
            System.Threading.Thread.Sleep(200);
            if (GetStillMovieMode(ref info) == 0x01) return;
        } while (DateTime.UtcNow < deadline);
        throw new InvalidOperationException("Camera did not enter still-image mode.");
    }
    static void WaitForCapture(ref SdkInfo info, byte imageId) {
        IntPtr statusBuffer = Marshal.AllocHGlobal(64 * 1024);
        try {
            var deadline = DateTime.UtcNow.AddSeconds(45);
            CaptureStatus last = new CaptureStatus();
            while (DateTime.UtcNow < deadline) {
                int received; Check(sgm_GetCamStatus2(ref info, 0, 0, 0, statusBuffer, 64 * 1024, out received), "sgm_GetCamStatus2");
                CaptureStatus status; Check(sgm_GetCamCaptStatus(ref info, imageId, out status), "sgm_GetCamCaptStatus");
                last = status;
                if (status.ImageId != imageId) { System.Threading.Thread.Sleep(150); continue; }
                if (status.Status == 0x0005 || status.Status == 0x8003) return;
                if (status.Status >= 0x6001 && status.Status <= 0x6FFF) throw new InvalidOperationException("Camera capture failed (status 0x" + status.Status.ToString("X4") + ", image ID " + status.ImageId + ", DB " + status.DatabaseHead + "-" + status.DatabaseTail + ", destination 0x" + status.Destination.ToString("X2") + ").");
                System.Threading.Thread.Sleep(150);
            }
            throw new TimeoutException("Timed out waiting for camera image ID " + imageId + " (last status 0x" + last.Status.ToString("X4") + ", camera image ID " + last.ImageId + ", DB " + last.DatabaseHead + "-" + last.DatabaseTail + ", destination 0x" + last.Destination.ToString("X2") + ").");
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

    public static string[] Probe(string sdkDirectory, string serial) {
        var info = Open(sdkDirectory, serial);
        var config = new IfdArray();
        try {
            Check(sgm_ConfigAPI(ref info, out config), "sgm_ConfigAPI details");
            string model = "SIGMA camera", firmware = "unknown";
            int size = Marshal.SizeOf(typeof(ImageFileDirectory));
            for (int i = 0; i < config.DirectoryCount; i++) {
                var entry = (ImageFileDirectory)Marshal.PtrToStructure(IntPtr.Add(config.Directory, i * size), typeof(ImageFileDirectory));
                if (entry.Value == IntPtr.Zero || entry.Count == 0 || entry.Count > 512) continue;
                if (entry.TagId != 0x0001 && entry.TagId != 0x0003) continue;
                var bytes = new byte[entry.Count]; Marshal.Copy(entry.Value, bytes, 0, bytes.Length);
                int end = Array.IndexOf(bytes, (byte)0); if (end < 0) end = bytes.Length;
                string value = System.Text.Encoding.ASCII.GetString(bytes, 0, end).Trim();
                if (entry.TagId == 0x0001 && value.Length > 0) model = value;
                if (entry.TagId == 0x0003 && value.Length > 0) firmware = value;
            }
            DataGroup1 group1; Check(sgm_GetCamDataGrp1(ref info, out group1), "sgm_GetCamDataGrp1 diagnostics");
            DataGroup2 group2; Check(sgm_GetCamDataGrp2(ref info, out group2), "sgm_GetCamDataGrp2 diagnostics");
            DataGroup3 group3; Check(sgm_GetCamDataGrp3(ref info, out group3), "sgm_GetCamDataGrp3 diagnostics");
            return new[] {
                model, firmware,
                GetStillMovieMode(ref info).ToString(),
                ((byte)group2.DriveMode).ToString(), ((byte)group2.SpecialMode).ToString(),
                ((byte)group2.ExposureMode).ToString(), ((byte)group2.ImageQuality).ToString(),
                ((byte)group3.DestinationToSave).ToString(), GetOperationPermission(ref info).ToString(),
                ((byte)group1.MediaStatus).ToString(), group1.MediaFreeSpace.ToString(),
                ((byte)group1.FrameBufferState).ToString(), ((byte)group1.BatteryState).ToString()
            };
        } finally {
            if (config.Directory != IntPtr.Zero) try { sgm_FreeArrayMemory(ref config); } catch {}
            Close(ref info);
        }
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

    public static string[] Capture(string sdkDirectory, string serial, string outputDirectory, string baseName, byte destination, byte imageQuality) {
        Directory.CreateDirectory(outputDirectory);
        var info = Open(sdkDirectory, serial);
        try {
            SelectPcOperation(ref info);
            SelectStillImageMode(ref info);
            ConfigureStillCapture(ref info, imageQuality);
            SelectCaptureDestination(ref info, destination);
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
            $details = [MotkSigmaSdk]::Probe($sdkDir, $resolvedSerial)
            Write-Result @{ ok = $true; camera = $details[0]; firmware = $details[1]; stillMovie = [int]$details[2]; driveMode = [int]$details[3]; specialMode = [int]$details[4]; exposureMode = [int]$details[5]; imageQuality = [int]$details[6]; destination = [int]$details[7]; operationPermission = [int]$details[8]; mediaStatus = [int]$details[9]; mediaFreeShots = [int]$details[10]; frameBuffer = [int]$details[11]; battery = [int]$details[12] }
        }
        'preview' {
            if (-not $Output) { throw '-Output is required for preview.' }
            [MotkSigmaSdk]::Preview($sdkDir, $resolvedSerial, $Output)
            Write-Result @{ ok = $true; output = [IO.Path]::GetFullPath($Output) }
        }
        'capture' {
            if (-not $OutputDir -or -not $BaseName) { throw '-OutputDir and -BaseName are required for capture.' }
            if ($BaseName -notmatch '^kdr_[0-9]{8}_[0-9]{6}_[0-9]{4}$') { throw 'Unsafe capture base name.' }
            $files = [MotkSigmaSdk]::Capture($sdkDir, $resolvedSerial, $OutputDir, $BaseName, [byte]$Destination, [byte]$ImageQuality)
            Write-Result @{ ok = $true; files = @($files) }
        }
    }
} catch {
    Fail $_.Exception.Message
}
