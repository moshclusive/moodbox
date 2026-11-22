; MoodBox 2.4.0 Inno Setup Script
#define MyAppName "MoodBox"
#define MyAppVersion "2.4.0"
#define MyAppPublisher "Moshclusive"
#define MyAppExeName "MoodBox.exe"

[Setup]
AppId={{9D75E4A4-52E7-4C77-B0DF-28D142E7B0BE}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\MoodBox
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.
OutputBaseFilename=MoodBox Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Assets\logo.ico
SetupIconFile=..\Software\Assets\logo.ico
CloseApplications=force
RestartApplications=no

[Code]
procedure KillRunningMoodBox();
var
  ErrorCode: Integer;
begin
  ShellExec('open', 'taskkill.exe', '/f /im MoodBox.exe', '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Sleep(400);
end;

procedure EnsureDirectoryNotBlockedByFile(const DirPath: String);
begin
  if FileExists(DirPath) and (not DirExists(DirPath)) then
  begin
    DeleteFile(DirPath);
  end;
end;

function InitializeSetup(): Boolean;
begin
  KillRunningMoodBox();
  Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  AppDir: String;
begin
  KillRunningMoodBox();
  AppDir := ExpandConstant('{app}');
  EnsureDirectoryNotBlockedByFile(AppDir);
  EnsureDirectoryNotBlockedByFile(AppDir + '\Assets');
  EnsureDirectoryNotBlockedByFile(AppDir + '\Extension');
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  KillRunningMoodBox();
  Result := True;
end;

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Dirs]
Name: "{app}\Assets"
Name: "{app}\Extension"

[Files]
Source: "..\Software\publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\Extension\*"; DestDir: "{app}\Extension"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\MoodBox"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\Assets\logo.ico"
Name: "{userdesktop}\MoodBox"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\Assets\logo.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--install-services"; Flags: runhidden waituntilterminated
Filename: "{sys}\ie4uinit.exe"; Parameters: "-show"; Flags: runhidden nowait skipifdoesntexist
Filename: "{app}\{#MyAppExeName}"; Description: "Launch MoodBox"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--uninstall-services"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "MoodBoxUninstallServices"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
