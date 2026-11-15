from capture_agent.live import greeting_pcm


def test_bundled_greeting_is_non_silent_pcm_in_transport_format():
    pcm = greeting_pcm()  # Validates 48 kHz / mono / s16 header.
    assert len(pcm) % 2 == 0
    assert 48_000 * 2 < len(pcm) < 48_000 * 2 * 20
    assert any(pcm)
