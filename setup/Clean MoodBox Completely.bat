@echo off
setlocal enableextensions enabledelayedexpansion
title Clean MoodBox Completely

echo ========================================================
echo        MoodBox Complete Deep Cleaner
echo ========================================================
echo.
echo Closing all running MoodBox instances...
taskkill /f /im MoodBox.exe >nul 2>&1
taskkill /f /im MoodBoxClipboard.exe >nul 2>&1
taskkill /f /im Contexta.exe >nul 2>&1
taskkill /f /im ContextaClipboard.exe >nul 2>&1

:: Run official uninstaller if present
if exist "%LOCALAPPDATA%\Programs\MoodBox\unins000.exe" (
    echo Running official uninstaller...
    "%LOCALAPPDATA%\Programs\MoodBox\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART >nul 2>&1
    timeout /t 2 /nobreak >nul 2>&1
)

echo Removing Registry entries...
:: Startup Run keys
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "MoodBox" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Contexta" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{9D75E4A4-52E7-4C77-B0DF-28D142E7B0BE}_is1" /f >nul 2>&1

:: Context menu entries - MoodBox
reg delete "HKCU\Software\Classes\DesktopBackground\Shell\MoodBox_Create" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\Background\shell\MoodBox_Create" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Drive\Background\shell\MoodBox_Create" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\shell\MoodBox_Generate" /f >nul 2>&1
reg delete "HKCU\Software\Classes\*\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\exefile\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\batfile\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\cmdfile\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Python.File\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.exe\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.bat\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.cmd\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.py\shell\MoodBox_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\woff2file\shell\MoodBox_ConvertWoff2" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.woff2\shell\MoodBox_ConvertWoff2" /f >nul 2>&1

:: Context menu entries - Legacy Contexta
reg delete "HKCU\Software\Classes\DesktopBackground\Shell\Contexta_Create" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\Background\shell\Contexta_Create" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Drive\Background\shell\Contexta_Create" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\shell\Contexta_Generate" /f >nul 2>&1
reg delete "HKCU\Software\Classes\*\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\exefile\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\batfile\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\cmdfile\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Python.File\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.exe\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.bat\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.cmd\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.py\shell\Contexta_QuickLauncher" /f >nul 2>&1
reg delete "HKCU\Software\Classes\woff2file\shell\Contexta_ConvertWoff2" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.woff2\shell\Contexta_ConvertWoff2" /f >nul 2>&1

:: Software settings keys
reg delete "HKCU\Software\MoodBox" /f >nul 2>&1
reg delete "HKCU\Software\Contexta" /f >nul 2>&1

echo Removing application installation files and caches...
if exist "%LOCALAPPDATA%\Programs\MoodBox" rmdir /s /q "%LOCALAPPDATA%\Programs\MoodBox" >nul 2>&1
if exist "%LOCALAPPDATA%\MoodBox" rmdir /s /q "%LOCALAPPDATA%\MoodBox" >nul 2>&1
if exist "%APPDATA%\MoodBox" rmdir /s /q "%APPDATA%\MoodBox" >nul 2>&1
if exist "%LOCALAPPDATA%\Programs\Contexta" rmdir /s /q "%LOCALAPPDATA%\Programs\Contexta" >nul 2>&1
if exist "%LOCALAPPDATA%\Contexta" rmdir /s /q "%LOCALAPPDATA%\Contexta" >nul 2>&1
if exist "%APPDATA%\Contexta" rmdir /s /q "%APPDATA%\Contexta" >nul 2>&1

echo Removing desktop and start menu shortcuts...
del /f /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\MoodBox.lnk" >nul 2>&1
del /f /q "%USERPROFILE%\Desktop\MoodBox.lnk" >nul 2>&1
del /f /q "%ALLUSERSPROFILE%\Microsoft\Windows\Start Menu\Programs\MoodBox.lnk" >nul 2>&1
del /f /q "%PUBLIC%\Desktop\MoodBox.lnk" >nul 2>&1
del /f /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Contexta.lnk" >nul 2>&1
del /f /q "%USERPROFILE%\Desktop\Contexta.lnk" >nul 2>&1

echo Rebuilding Windows Icon Cache (removing old cached blue icon)...
taskkill /f /im explorer.exe >nul 2>&1
timeout /t 1 /nobreak >nul 2>&1
del /f /q "%LOCALAPPDATA%\IconCache.db" >nul 2>&1
del /f /q "%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache*.db" >nul 2>&1
start explorer.exe >nul 2>&1
ie4uinit.exe -show >nul 2>&1

echo.
echo ========================================================
echo       [SUCCESS] MoodBox has been completely cleaned!
echo ========================================================
echo.
echo [1] Previous installations, registry menus, and caches are removed.
echo [2] Your project folders on Desktop/Downloads were kept safe and untouched.
echo [3] Now you can install the new:
echo       "Setup\MoodBox Setup.exe"
echo.
pause
