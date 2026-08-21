# EXIF orientation fixture

`Landscape_6.jpg` is the real-pixel orientation-6 example from
[`recurser/exif-orientation-examples`](https://github.com/recurser/exif-orientation-examples):

- upstream commit: `9057a78281ca22f5aa28c78ba89db54a487c52a3`
- upstream blob: `b579b7f9abda2a47fd6bed69f32cf235516eb389`
- bytes: `352727`
- SHA-256: `9b344e9f0c869d8637ea22e672df9451d8d3cc1d2d0b291af3b284e538e5f124`
- stored JPEG axes: `1200x1800`
- EXIF orientation: `6` (`RightTop`)

The upstream generator rotates the pixel raster before writing orientation 6,
so this fixture is not a metadata-only edit. The upstream README credits the
underlying Unsplash photograph to Pierre Bouillot and licenses the example
images under MIT. The pinned upstream license is included beside the fixture.

Only orientation 6 is vendored (352,727 bytes); the other 15 upstream examples
are intentionally not copied. Small metadata cases audit orientations 1-8:
only 1 and 6 are accepted, while 2-5 and 7-8 fail closed until they have the
same browser-label and archive-recrop evidence.
