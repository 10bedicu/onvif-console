import os
import sys

# Make backend/ importable so tests can `from onvif_ptz import PTZClient`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
