import sys, time
sys.path.insert(0, '/home/kidelee/Projects/HQ-SciFi/.dsh-tmp/python-xlib-0.33')
from Xlib import display, X, XK
from Xlib.ext import xtest

d = display.Display(':1')
root = d.screen().root

def walk(w, depth=0):
    try:
        attrs = w.get_attributes()
        if attrs.map_state != X.IsViewable:
            return
        g = w.get_geometry()
        name = w.get_wm_name() or ''
        cls = ''
        try:
            c = w.get_wm_class()
            if c: cls = '/'.join(c)
        except Exception: pass
        print('  '*depth + f'{hex(w.id)} {g.width}x{g.height}+{g.x}+{g.y} name={name!r} cls={cls!r}')
        for ch in w.query_tree().children:
            walk(ch, depth+1)
    except Exception as e:
        pass

def click(x, y, button=1):
    xtest.fake_input(d, X.MotionNotify, x=x, y=y); d.sync(); time.sleep(0.15)
    xtest.fake_input(d, X.ButtonPress, button); d.sync(); time.sleep(0.08)
    xtest.fake_input(d, X.ButtonRelease, button); d.sync(); time.sleep(0.3)

def key(seq):
    # seq like 'ctrl+comma' or 'alt+f' or 'Return'
    parts = seq.split('+')
    mods = {'ctrl': 'Control_L', 'alt': 'Alt_L', 'shift': 'Shift_L', 'super': 'Super_L'}
    mkeys = [d.keysym_to_keycode(XK.string_to_keysym(mods[p])) for p in parts[:-1]]
    kk = d.keysym_to_keycode(XK.string_to_keysym(parts[-1]))
    for m in mkeys:
        xtest.fake_input(d, X.KeyPress, m)
    xtest.fake_input(d, X.KeyPress, kk); d.sync(); time.sleep(0.06)
    xtest.fake_input(d, X.KeyRelease, kk)
    for m in reversed(mkeys):
        xtest.fake_input(d, X.KeyRelease, m)
    d.sync(); time.sleep(0.3)

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    if cmd == 'list':
        walk(root)
    elif cmd == 'click':
        click(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == 'key':
        key(sys.argv[2])
    elif cmd == 'focus':
        wid = int(sys.argv[2], 16)
        w = d.create_resource_object('window', wid)
        w.set_input_focus(X.RevertToParent, X.CurrentTime); d.sync()
    elif cmd == 'geom':
        wid = int(sys.argv[2], 16)
        w = d.create_resource_object('window', wid)
        g = w.get_geometry(); print(g.x, g.y, g.width, g.height)
