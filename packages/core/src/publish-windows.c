int MoveFileExW(const unsigned short *source, const unsigned short *destination, unsigned int flags);
unsigned int GetLastError(void);

unsigned int publish_file(const unsigned short *source, const unsigned short *destination) {
    /* Capture the Windows error before returning through the JavaScript runtime. */
    return MoveFileExW(source, destination, 0) ? 0 : GetLastError();
}
