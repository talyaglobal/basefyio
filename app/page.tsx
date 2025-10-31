import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col items-center justify-center p-4">
      <div className="max-w-4xl mx-auto text-center">
        <h1 className="text-5xl font-bold text-gray-900 mb-6">
          Welcome to <span className="text-blue-600">Kolaybase</span>
        </h1>
        <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
          A powerful PostgreSQL database management platform. Build, manage, and scale your applications with ease.
        </p>
        <div className="flex gap-4 justify-center">
          <Link href="/sign-up">
            <Button size="lg" className="px-8">
              Get Started
            </Button>
          </Link>
          <Link href="/sign-in">
            <Button variant="outline" size="lg" className="px-8">
              Sign In
            </Button>
          </Link>
        </div>
        
        <div className="mt-16 grid md:grid-cols-3 gap-8">
          <div className="bg-white p-6 rounded-lg shadow-sm">
            <h3 className="text-lg font-semibold mb-2">Database Management</h3>
            <p className="text-gray-600">Create, manage, and query your PostgreSQL databases with an intuitive interface.</p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-sm">
            <h3 className="text-lg font-semibold mb-2">API Generation</h3>
            <p className="text-gray-600">Automatically generate REST and GraphQL APIs from your database schema.</p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-sm">
            <h3 className="text-lg font-semibold mb-2">Real-time Updates</h3>
            <p className="text-gray-600">Get real-time updates and notifications for your database changes.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
