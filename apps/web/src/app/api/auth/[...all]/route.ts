import { auth } from '@/lib/server/auth';

const { handler } = auth;
export { handler as GET, handler as POST };
