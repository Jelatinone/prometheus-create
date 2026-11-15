# Regenerate the bundled greeting locally on Windows. No cloud TTS or provider key.
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
try {
    $speaker.SetOutputToWaveFile((Join-Path $PSScriptRoot 'assets/capture-ready.wav'), $format)
    $speaker.Speak('Capture connected. Please show one object clearly and move slowly. I am saving selected camera frames. This call will end automatically.')
} finally {
    $speaker.Dispose()
}
